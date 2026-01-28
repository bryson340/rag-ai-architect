# RAG System Design Decisions

## 1. Chunking Strategy
**Choice:** `RecursiveCharacterTextSplitter` with `chunk_size=1000` and `chunk_overlap=200`.
**Reasoning:**
- **Size (1000):** This size captures roughly 2-3 paragraphs of context. This is ideal because it provides enough information for the LLM to understand the topic without hitting token limits or diluting the vector's meaning with unrelated topics.
- **Overlap (200):** We use overlap to ensure that sentences are not cut in half at the chunk boundaries. This preserves semantic meaning across chunks, ensuring that specific details located at the edge of a chunk are not lost during retrieval.

## 2. Retrieval Failure Case Observed
**Issue:** "The False Context Match"
**Observation:** When asking "What is the budget?", the system retrieved a paragraph from a different document (Project B) instead of the intended document (Project A) because they both used similar financial terminology.
**Resolution:** To fix this, we added **Metadata Filtering**. We now tag every chunk with `filename` metadata. In the future, we can restrict the vector search to only query chunks that match the specific `filename` the user is currently viewing.

## 3. Metric Tracked
**Metric:** **Cosine Similarity Score** (Pinecone `score`)
**Why:** We log the score of every retrieved chunk.
- If scores are consistently **< 0.50**, it indicates our embeddings are poor or the user's question is unrelated to the document.
- If scores are **> 0.85**, we have high confidence in the answer.
- We set a threshold of **0.30** in the code; any chunk below this is discarded to prevent "hallucinations" based on irrelevant noise.