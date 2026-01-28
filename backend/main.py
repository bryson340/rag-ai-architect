from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Form, BackgroundTasks, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import os
import json
import shutil
import asyncio
from datetime import datetime
from dotenv import load_dotenv

# --- IMPORTS ---
from pinecone import Pinecone 
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.document_loaders import PyMuPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
import google.generativeai as genai

from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session, relationship
from passlib.context import CryptContext

load_dotenv()

# --- DB SETUP ---
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
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
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
    try: yield db
    finally: db.close()

# --- CONFIG ---
limiter = Limiter(key_func=get_remote_address)
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

os.makedirs("uploaded_docs", exist_ok=True)
app.mount("/static", StaticFiles(directory="uploaded_docs"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")
genai.configure(api_key=GOOGLE_API_KEY)

# --- INGESTION ---
def ingest_document_job(file_path: str, filename: str, user_id: Optional[int]):
    safe_user_id = str(user_id) if user_id is not None else "None"
    print(f"🚀 Starting background ingestion for: {filename} (User: {safe_user_id})")
    try:
        documents = []
        if filename.lower().endswith(".pdf"):
            loader = PyMuPDFLoader(file_path)
            documents = loader.load()
        elif filename.lower().endswith(".txt"):
            loader = TextLoader(file_path, encoding="utf-8")
            documents = loader.load()
        
        if not documents: return

        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        docs = text_splitter.split_documents(documents)
        
        # Keep using the standard embedding model (it worked for you earlier)
        embeddings = GoogleGenerativeAIEmbeddings(model="models/gemini-embedding-001", google_api_key=GOOGLE_API_KEY)
        pc = Pinecone(api_key=PINECONE_API_KEY)
        index = pc.Index(PINECONE_INDEX_NAME)
        
        vectors = []
        for i, doc in enumerate(docs):
            vector = embeddings.embed_query(doc.page_content)
            page_num = doc.metadata.get("page", 0) + 1
            meta = {
                "text": doc.page_content, "page": page_num,
                "filename": filename, "user_id": safe_user_id
            }
            vectors.append((f"{safe_user_id}_{filename}_chunk_{i}", vector, meta))
            
        if vectors:
            batch_size = 100
            for i in range(0, len(vectors), batch_size):
                index.upsert(vectors=vectors[i:i + batch_size])
            print(f"✅ Finished ingesting {len(vectors)} chunks for {filename}")

    except Exception as e:
        print(f"❌ Background Job Failed: {e}")

# --- ROUTES ---
class UserAuth(BaseModel):
    username: str
    password: str

@app.post("/register")
@limiter.limit("5/minute")
def register(request: Request, user: UserAuth, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == user.username).first():
        raise HTTPException(status_code=400, detail="Username taken")
    new_user = User(username=user.username, hashed_password=pwd_context.hash(user.password))
    db.add(new_user); db.commit()
    return {"status": "User created"}

@app.post("/login")
@limiter.limit("10/minute")
def login(request: Request, user: UserAuth, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if not db_user or not pwd_context.verify(user.password, db_user.hashed_password):
        raise HTTPException(status_code=400, detail="Invalid credentials")
    return {"user_id": db_user.id, "username": db_user.username}

@app.get("/sessions/{user_id}")
def get_sessions(user_id: int, db: Session = Depends(get_db)):
    sessions = db.query(ChatSession).filter(ChatSession.user_id == user_id).order_by(ChatSession.created_at.desc()).all()
    return [{"id": s.id, "pdf_name": s.pdf_name, "date": s.created_at} for s in sessions]

@app.get("/history/{session_id}")
def get_history(session_id: int, db: Session = Depends(get_db)):
    messages = db.query(ChatMessage).filter(ChatMessage.session_id == session_id).all()
    return [{"role": m.role, "content": m.content, "sources": json.loads(m.sources) if m.sources else []} for m in messages]

@app.delete("/sessions/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db)):
    session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if session: db.delete(session); db.commit()
    return {"status": "deleted"}

@app.post("/upload")
@limiter.limit("5/minute")
async def upload_file(request: Request, background_tasks: BackgroundTasks, file: UploadFile = File(...), user_id: Optional[int] = Form(None), db: Session = Depends(get_db)):
    if not (file.filename.lower().endswith(".pdf") or file.filename.lower().endswith(".txt")):
        raise HTTPException(status_code=400, detail="Allowed: PDF, TXT")

    file_loc = f"uploaded_docs/{file.filename}"
    with open(file_loc, "wb") as buffer: shutil.copyfileobj(file.file, buffer)
    
    background_tasks.add_task(ingest_document_job, file_loc, file.filename, user_id)
    
    new_session = ChatSession(user_id=user_id, pdf_name=file.filename)
    db.add(new_session); db.commit(); db.refresh(new_session)
    
    return {
        "status": "processing_started", "message": "Uploaded.",
        "session_id": new_session.id, 
        "filename": file.filename, "pdf_name": file.filename 
    }

class QueryRequest(BaseModel):
    question: str
    history: List[dict] = []
    session_id: int

@app.post("/chat")
@limiter.limit("20/minute")
async def chat_endpoint(request: Request, query: QueryRequest, db: Session = Depends(get_db)):
    question = query.question
    session = db.query(ChatSession).filter(ChatSession.id == query.session_id).first()
    if not session: raise HTTPException(status_code=404, detail="Session not found")
    
    current_fname = session.pdf_name
    current_uid = str(session.user_id) if session.user_id is not None else "None"

    db.add(ChatMessage(session_id=query.session_id, role="user", content=question, sources="[]"))
    db.commit()

    # --- RETRIEVAL ---
    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(PINECONE_INDEX_NAME)
    # Using the standard embedding model (confirmed working)
    embeddings = GoogleGenerativeAIEmbeddings(model="models/gemini-embedding-001", google_api_key=GOOGLE_API_KEY)
    
    query_vector = None
    for _ in range(3):
        try: query_vector = embeddings.embed_query(question); break
        except: await asyncio.sleep(1)
            
    if not query_vector: return JSONResponse(status_code=503, content={"detail": "AI Busy"})

    search_res = index.query(
        vector=query_vector, top_k=5, include_metadata=True,
        filter={"user_id": current_uid, "filename": current_fname} 
    )
    
    context, sources, seen = "", [], set()
    for m in search_res['matches']:
        if m['score'] > 0.30:
            meta = m['metadata']
            fname = meta.get('filename', 'Unknown')
            context += f"Source ({fname}): {meta['text']}\n\n"
            key = f"{fname}_{meta.get('page')}"
            if key not in seen:
                sources.append({"page": int(meta.get('page', 0)), "filename": fname})
                seen.add(key)

    # --- GENERATION WITH YOUR AVAILABLE MODELS ---
    system_prompt = f"Answer based on:\n{context}" if context else "No context found. Answer nicely."
    full_prompt = f"{system_prompt}\n\nQuestion: {question}\nAnswer concisely."

    async def event_generator():
        yield json.dumps({"type": "sources", "data": sources}) + "\n"
        full_answer = ""
        
        # !!! UPDATED MODEL LIST BASED ON YOUR LOGS !!!
        model_candidates = [
            "gemini-2.0-flash",       # Top priority (New & Fast)
            "gemini-flash-latest",    # Reliable alias
            "gemini-2.0-flash-lite",  # Backup
            "gemini-pro-latest"       # Fallback
        ]
        
        success = False
        for model_name in model_candidates:
            try:
                # IMPORTANT: Use 'models/' prefix or raw name based on library quirk, trying raw first
                model = genai.GenerativeModel(model_name)
                response = model.generate_content(full_prompt, stream=True)
                for chunk in response:
                    if chunk.text:
                        full_answer += chunk.text
                        yield json.dumps({"type": "content", "data": chunk.text}) + "\n"
                        await asyncio.sleep(0.01)
                success = True
                break 
            except Exception as e:
                print(f"⚠️ Model {model_name} failed: {e}")
                continue 
        
        if not success:
             err = "\n\n❌ All AI models failed. Please check API Key permissions."
             yield json.dumps({"type": "content", "data": err}) + "\n"
             full_answer += err

        if full_answer:
            try:
                new_db = SessionLocal()
                new_db.add(ChatMessage(session_id=query.session_id, role="ai", content=full_answer, sources=json.dumps(sources)))
                new_db.commit(); new_db.close()
            except: pass

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

if __name__ == "__main__":
    import uvicorn
    print("✅ BACKEND v4.0 (Gemini 2.0 Enabled)")
    uvicorn.run(app, host="0.0.0.0", port=8000)