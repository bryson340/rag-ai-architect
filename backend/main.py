from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Form
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import os
import json
import shutil
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from pinecone import Pinecone
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
import google.generativeai as genai
from fastapi.middleware.cors import CORSMiddleware

# --- DATABASE IMPORTS ---
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session, relationship
from passlib.context import CryptContext

load_dotenv()

# --- DATABASE SETUP ---
SQLALCHEMY_DATABASE_URL = "sqlite:///./chat_app.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    sessions = relationship("ChatSession", back_populates="owner")

class ChatSession(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    pdf_name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")
    owner = relationship("User", back_populates="sessions")

class ChatMessage(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"))
    role = Column(String)
    content = Column(Text)
    sources = Column(Text)
    session = relationship("ChatSession", back_populates="messages")

Base.metadata.create_all(bind=engine)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

app = FastAPI()

# MOUNT STATIC FILES (So frontend can view PDFs)
os.makedirs("uploaded_docs", exist_ok=True)
app.mount("/static", StaticFiles(directory="uploaded_docs"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")
genai.configure(api_key=GOOGLE_API_KEY)

# --- AUTH ---
class UserAuth(BaseModel):
    username: str
    password: str

@app.post("/register")
def register(user: UserAuth, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username taken")
    hashed_password = pwd_context.hash(user.password)
    new_user = User(username=user.username, hashed_password=hashed_password)
    db.add(new_user)
    db.commit()
    return {"status": "User created"}

@app.post("/login")
def login(user: UserAuth, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if not db_user or not pwd_context.verify(user.password, db_user.hashed_password):
        raise HTTPException(status_code=400, detail="Invalid credentials")
    return {"user_id": db_user.id, "username": db_user.username}

# --- SESSION MANAGEMENT ---
@app.get("/sessions/{user_id}")
def get_user_sessions(user_id: int, db: Session = Depends(get_db)):
    sessions = db.query(ChatSession).filter(ChatSession.user_id == user_id).order_by(ChatSession.created_at.desc()).all()
    return [{"id": s.id, "pdf_name": s.pdf_name, "date": s.created_at} for s in sessions]

@app.get("/history/{session_id}")
def get_chat_history(session_id: int, db: Session = Depends(get_db)):
    messages = db.query(ChatMessage).filter(ChatMessage.session_id == session_id).all()
    return [{"role": m.role, "content": m.content, "sources": json.loads(m.sources) if m.sources else []} for m in messages]

@app.delete("/sessions/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db)):
    session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return {"status": "deleted"}

# --- UPLOAD & CHAT ---
def process_pdf_ingest(file_path, filename):
    try:
        loader = PyMuPDFLoader(file_path)
        documents = loader.load()
    except Exception as e:
        raise ValueError(f"Error reading PDF: {e}")

    if not documents:
        raise ValueError("PDF appears to be empty or unreadable.")

    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    docs = text_splitter.split_documents(documents)
    
    embeddings = GoogleGenerativeAIEmbeddings(model="models/text-embedding-004", google_api_key=GOOGLE_API_KEY)
    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(PINECONE_INDEX_NAME)
    
    vectors = []
    for i, doc in enumerate(docs):
        vector = embeddings.embed_query(doc.page_content)
        page_num = doc.metadata.get("page", 0) + 1
        
        meta = {
            "text": doc.page_content, 
            "page": page_num,
            "filename": filename
        }
        unique_id = f"{filename}_chunk_{i}"
        vectors.append((unique_id, vector, meta))
        
    if vectors:
        index.upsert(vectors=vectors)

@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...), 
    user_id: Optional[int] = Form(None), 
    db: Session = Depends(get_db)
):
    file_location = f"uploaded_docs/{file.filename}"
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    try:
        process_pdf_ingest(file_location, file.filename)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=f"PDF Error: {str(ve)}")
    except Exception as e:
        print(f"Ingestion failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to process document")
    
    session_id = None
    if user_id:
        new_session = ChatSession(user_id=user_id, pdf_name=file.filename)
        db.add(new_session)
        db.commit()
        db.refresh(new_session)
        session_id = new_session.id
        
    return {"status": "success", "session_id": session_id, "filename": file.filename}

class QueryRequest(BaseModel):
    question: str
    history: List[dict] = []
    session_id: Optional[int] = None 

@app.post("/chat")
async def chat_endpoint(request: QueryRequest, db: Session = Depends(get_db)):
    question = request.question
    session_id = request.session_id
    
    if session_id:
        user_msg = ChatMessage(session_id=session_id, role="user", content=question, sources="[]")
        db.add(user_msg)
        db.commit()

    embeddings = GoogleGenerativeAIEmbeddings(model="models/text-embedding-004", google_api_key=GOOGLE_API_KEY)
    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(PINECONE_INDEX_NAME)

    query_vector = embeddings.embed_query(question)
    search_results = index.query(vector=query_vector, top_k=5, include_metadata=True)
    
    context_text = ""
    sources = []
    seen_pages = set()

    for match in search_results['matches']:
        if match['score'] > 0.30: 
            meta = match['metadata']
            context_text += f"Source ({meta.get('filename', 'Unknown')}): {meta['text']}\n\n"
            
            source_key = f"{meta.get('filename')}_{meta.get('page')}"
            if source_key not in seen_pages:
                sources.append({
                    "page": int(meta.get('page', 0)),
                    "filename": meta.get('filename', 'Unknown')
                })
                seen_pages.add(source_key)

    if not context_text:
        system_instruction = "You are a helpful assistant. The user asked a question, but no relevant content was found in the database. Politely explain that."
    else:
        system_instruction = f"You are an expert analyst. Answer based ONLY on the following context:\n\n{context_text}"

    prompt = f"{system_instruction}\n\nQuestion: {question}\nAnswer concisely with bullets."
    
    model = genai.GenerativeModel('models/gemini-flash-latest')
    
    # --- UPDATED GENERATOR WITH ERROR HANDLING ---
    async def event_generator():
        # Send Sources First
        yield json.dumps({"type": "sources", "data": sources}) + "\n"
        
        full_answer = ""
        try:
            # --- TRY BLOCK FOR API CALL ---
            response = model.generate_content(prompt, stream=True)
            for chunk in response:
                if chunk.text:
                    full_answer += chunk.text
                    yield json.dumps({"type": "content", "data": chunk.text}) + "\n"
                    await asyncio.sleep(0.01)
                    
        except Exception as e:
            # --- CATCH RATE LIMIT ERRORS ---
            error_msg = "\n\n⚠️ **API Limit Reached:** Please wait 30 seconds and try again. (Google Free Tier Quota)"
            yield json.dumps({"type": "content", "data": error_msg}) + "\n"
            full_answer += error_msg
        
        # Save AI Msg (Only if we got some answer)
        if session_id and full_answer:
            try:
                new_db = SessionLocal()
                ai_msg = ChatMessage(session_id=session_id, role="ai", content=full_answer, sources=json.dumps(sources))
                new_db.add(ai_msg)
                new_db.commit()
                new_db.close()
            except Exception as e:
                print(f"Error saving history: {e}")

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)