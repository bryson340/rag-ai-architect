import google.generativeai as genai
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GOOGLE_API_KEY")
if not api_key:
    print("❌ Error: GOOGLE_API_KEY not found in .env")
else:
    genai.configure(api_key=api_key)
    print(f"✅ Key found: {api_key[:5]}...*****")
    print("\n🔍 Scanning for available Chat Models...")
    
    try:
        found = False
        for m in genai.list_models():
            if 'generateContent' in m.supported_generation_methods:
                print(f"   - {m.name}")
                found = True
        
        if not found:
            print("\n❌ No Chat Models found. Your API Key might only have access to Embeddings?")
            print("   Try creating a new API Key at: https://aistudio.google.com/")
    except Exception as e:
        print(f"\n❌ Error contacting Google: {e}")