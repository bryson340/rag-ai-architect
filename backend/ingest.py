import os
import sys
import time
from dotenv import load_dotenv
from pinecone import Pinecone
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings

# 1. Load environment variables
load_dotenv() 

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")

if not GOOGLE_API_KEY or not PINECONE_API_KEY:
    print("❌ Error: Missing API keys in .env file")
    sys.exit(1)

def ingest_pdf(pdf_path):
    print("--- Starting Ingestion (New Model) ---")
    
    # 2. Load PDF
    print(f"Loading PDF: {pdf_path}...")
    try:
        loader = PyPDFLoader(pdf_path)
        documents = loader.load()
        print(f"Loaded {len(documents)} pages.")
    except Exception as e:
        print(f"❌ Error loading PDF: {e}")
        return

    # 3. Split Text
    print("Splitting text...")
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    docs = text_splitter.split_documents(documents)
    print(f"Created {len(docs)} text chunks.")

    # 4. Initialize Embeddings (UPDATED MODEL)
    print("Initializing Gemini Embeddings (text-embedding-004)...")
    try:
        embeddings = GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",  # <--- NEW MODEL
            google_api_key=GOOGLE_API_KEY
        )
    except Exception as e:
        print(f"❌ Error initializing Embeddings: {e}")
        return

    # 5. Connect to Pinecone
    print("Connecting to Pinecone...")
    try:
        pc = Pinecone(api_key=PINECONE_API_KEY)
        index = pc.Index(PINECONE_INDEX_NAME)
    except Exception as e:
        print(f"❌ Error connecting to Pinecone: {e}")
        return

    # 6. Upload
    print("Embedding and Uploading...")
    vectors_to_upsert = []
    
    for i, doc in enumerate(docs):
        try:
            # Generate embedding
            vector = embeddings.embed_query(doc.page_content)
            
            chunk_id = f"chunk-{i}"
            metadata = {"text": doc.page_content, "page": doc.metadata.get("page", 0)}
            
            vectors_to_upsert.append((chunk_id, vector, metadata))

            # Batch upload every 50 chunks
            if len(vectors_to_upsert) >= 50:
                index.upsert(vectors=vectors_to_upsert)
                vectors_to_upsert = [] 
                print(f"Uploaded batch ending at chunk {i}")
                time.sleep(1) # <--- Pause for 1 second to avoid rate limits
        except Exception as e:
            print(f"❌ Error processing chunk {i}: {e}")

    if vectors_to_upsert:
        index.upsert(vectors=vectors_to_upsert)
        print("Uploaded final batch.")

    print("--- Ingestion Complete! ---")

if __name__ == "__main__":
    ingest_pdf("sample.pdf")