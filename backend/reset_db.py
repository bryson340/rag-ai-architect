import os
import time
from pinecone import Pinecone, ServerlessSpec
from dotenv import load_dotenv

load_dotenv()

# 1. Config
API_KEY = os.getenv("PINECONE_API_KEY")
INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")

pc = Pinecone(api_key=API_KEY)

# 2. Delete Old Index
if INDEX_NAME in [i.name for i in pc.list_indexes()]:
    print(f"🗑️  Deleting index '{INDEX_NAME}' (Dimension 768)...")
    pc.delete_index(INDEX_NAME)
    print("⏳ Waiting 20 seconds for deletion to finish...")
    time.sleep(20)
else:
    print(f"Index '{INDEX_NAME}' does not exist. Creating new one...")

# 3. Create New Index (Dimension 3072)
print(f"🆕 Creating index '{INDEX_NAME}' with Dimension 3072...")
try:
    pc.create_index(
        name=INDEX_NAME,
        dimension=3072,  # <--- THIS IS THE FIX
        metric="cosine",
        spec=ServerlessSpec(
            cloud="aws",
            region="us-east-1" # Change this if your Pinecone is in a different region
        )
    )
    print("✅ Success! Database reset.")
except Exception as e:
    print(f"❌ Error: {e}")