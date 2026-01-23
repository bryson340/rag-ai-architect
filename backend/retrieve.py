import os
import sys
import time
from dotenv import load_dotenv
from pinecone import Pinecone
from langchain_google_genai import GoogleGenerativeAIEmbeddings
import google.generativeai as genai

# 1. Load Keys
load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")

# Configure Gemini
genai.configure(api_key=GOOGLE_API_KEY)

def ask_gemini(question):
    print(f"\n❓ Question: {question}")
    
    # 2. Setup (MUST match the model used in ingest.py)
    embeddings = GoogleGenerativeAIEmbeddings(
        model="models/text-embedding-004", 
        google_api_key=GOOGLE_API_KEY
    )
    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(PINECONE_INDEX_NAME)

    # 3. Search Pinecone
    print("🔍 Searching database...")
    try:
        query_vector = embeddings.embed_query(question)
        search_results = index.query(vector=query_vector, top_k=3, include_metadata=True)
    except Exception as e:
        print(f"❌ Error during search: {e}")
        return

    # 4. Extract Text
    context_text = ""
    for match in search_results['matches']:
        context_text += match['metadata']['text'] + "\n\n"

    if not context_text:
        print("❌ No relevant information found.")
        return

    # 5. Build Prompt
    prompt = f"""
    You are a helpful assistant. Answer the question based ONLY on the following context.
    
    Context:
    {context_text}
    
    Question: 
    {question}
    """

    # 6. Ask Gemini
    print("🤖 Generating answer...")
    try:
        # Using the model found in your check_models.py list
        model = genai.GenerativeModel('models/gemini-flash-latest') 
        response = model.generate_content(prompt)
        print("\n✅ Answer:")
        print(response.text)
    except Exception as e:
        print(f"❌ Generation Error: {e}")
        print("You might be hitting a rate limit. Wait 60 seconds and try again.")

if __name__ == "__main__":
    ask_gemini("What is this document about?")