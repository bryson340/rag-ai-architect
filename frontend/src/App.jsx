import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './index.css';

function App() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]); 
  const [loading, setLoading] = useState(false);
  
  // Session & Auth State
  const [user, setUser] = useState(null);
  const [sessions, setSessions] = useState([]); 
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [activePdfUrl, setActivePdfUrl] = useState(null);
  
  // UI Layout States
  const [toast, setToast] = useState(null); 
  const [showAuth, setShowAuth] = useState(false);
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  
  // Responsive States
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState('chat'); // 'chat' or 'pdf'
  const [isPdfFullScreen, setIsPdfFullScreen] = useState(false); // For Desktop focus mode
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  const chatEndRef = useRef(null);

  const quickActions = [
    { label: "📝 Summarize", prompt: "Summarize this document in 5 concise bullet points." },
    { label: "⚠️ Risks", prompt: "Identify potential risks, warnings, or negative clauses." },
    { label: "📅 Dates", prompt: "List all important dates, deadlines, and timelines." },
  ];

  // Handle Resize
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth < 768) setIsSidebarOpen(false); // Auto-close sidebar on mobile
      else setIsSidebarOpen(true);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, mobileTab]); // Scroll when tab changes too

  useEffect(() => {
    if (user) loadSessions();
  }, [user]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
  };

  const loadSessions = async () => {
    try {
      const res = await axios.get(`http://localhost:8000/sessions/${user.user_id}`);
      setSessions(res.data);
    } catch (e) { console.error(e); }
  };

  const loadChat = async (session) => {
    setCurrentSessionId(session.id);
    const safeFilename = encodeURIComponent(session.pdf_name);
    setActivePdfUrl(`http://localhost:8000/static/${safeFilename}`);
    
    // On mobile, auto-switch to PDF view when loading a chat
    if (isMobile) {
        setMobileTab('pdf');
        setIsSidebarOpen(false);
    }

    setLoading(true);
    try {
      const res = await axios.get(`http://localhost:8000/history/${session.id}`);
      setMessages(res.data);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const deleteSession = async (e, sessionId) => {
      e.stopPropagation();
      if (!window.confirm("Delete this chat?")) return;
      try {
          await axios.delete(`http://localhost:8000/sessions/${sessionId}`);
          setSessions(prev => prev.filter(s => s.id !== sessionId));
          showToast("Chat deleted", "success");
          if (currentSessionId === sessionId) {
              setMessages([]);
              setCurrentSessionId(null);
              setActivePdfUrl(null);
          }
      } catch (error) { showToast("Failed to delete", "error"); }
  };

  const handleAuth = async () => {
    const endpoint = isLogin ? "/login" : "/register";
    try {
      const res = await axios.post(`http://localhost:8000${endpoint}`, { username, password });
      if (isLogin) {
        setUser(res.data);
        setShowAuth(false);
        showToast(`Welcome back, ${res.data.username}!`);
      } else {
        showToast("Registration successful! Please log in.");
        setIsLogin(true);
      }
    } catch (e) { showToast(e.response?.data?.detail || "Auth Failed", "error"); }
  };

  const handleUpload = async (fileToUpload) => {
    if (!fileToUpload) return;
    showToast("⏳ Uploading...", "info");
    
    const formData = new FormData();
    formData.append("file", fileToUpload);
    if (user) formData.append("user_id", user.user_id); 

    try {
      const res = await axios.post("http://localhost:8000/upload", formData);
      showToast("✅ Upload Successful!", "success");
      setMessages([]); 
      
      if (res.data.session_id) {
        await loadSessions();
        const newSession = { id: res.data.session_id, pdf_name: res.data.filename };
        loadChat(newSession);
      }
    } catch (error) { 
      console.error(error);
      showToast("❌ Upload Failed.", "error"); 
    }
  };

  const askAI = async (manualPrompt = null) => {
    const query = typeof manualPrompt === "string" ? manualPrompt : question;
    if (!query) return;
    
    const userMsg = { role: "user", content: query };
    setMessages(prev => [...prev, userMsg]);
    setQuestion(""); 
    setLoading(true);

    const aiMsgId = Date.now();
    setMessages(prev => [...prev, { role: "ai", content: "", sources: [], id: aiMsgId }]);

    try {
      const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query, history: messages, session_id: currentSessionId })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter(line => line.trim() !== "");

        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                setMessages(prev => prev.map(msg => {
                    if (msg.id === aiMsgId) {
                        if (json.type === "sources") return { ...msg, sources: json.data };
                        if (json.type === "content") return { ...msg, content: msg.content + json.data };
                    }
                    return msg;
                }));
            } catch (e) {}
        }
      }
    } catch (error) { console.error(error); } finally { setLoading(false); }
  };

  const handleCitationClick = (filename, page) => {
      // Switch to PDF tab on mobile if clicking a citation
      if (isMobile) setMobileTab('pdf');
      
      const safeFilename = encodeURIComponent(filename);
      const newUrl = `http://localhost:8000/static/${safeFilename}`;
      
      if (activePdfUrl?.split('#')[0] !== newUrl) setActivePdfUrl(newUrl);
      setTimeout(() => setActivePdfUrl(`${newUrl}#page=${page}`), 100);
  };

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100vh', background:'#0f172a', color:'white', fontFamily:'"Inter", sans-serif', overflow:'hidden'}}>
      
      {/* --- TOAST NOTIFICATION --- */}
      {toast && (
        <div style={{
          position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
          background: toast.type === 'error' ? '#ef4444' : toast.type === 'info' ? '#3b82f6' : '#10b981',
          color: 'white', padding: '10px 20px', borderRadius: '8px', zIndex: 2000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontWeight: '600', animation: 'fadeIn 0.3s'
        }}>
          {toast.message}
        </div>
      )}

      {/* --- HEADER --- */}
      <div style={{
          height:'60px', background:'#1e293b', borderBottom:'1px solid #334155', 
          display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 20px', flexShrink: 0
      }}>
          <div style={{display:'flex', alignItems:'center', gap:'15px'}}>
              {/* Hamburger Menu (Mobile/Desktop Toggle) */}
              <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={{background:'none', border:'none', color:'white', fontSize:'20px', cursor:'pointer'}}>
                  ☰
              </button>
              
              <div style={{fontWeight:'700', fontSize:'18px', display:'flex', alignItems:'center', gap:'10px'}}>
                  <span style={{fontSize:'22px'}}>🧠</span> 
                  {!isMobile && <span>RAG Architect</span>}
              </div>
          </div>

          <div style={{display:'flex', gap:'10px', alignItems:'center'}}>
               {/* Upload Button (Header) */}
               <label style={{cursor:"pointer", padding:"8px 15px", background:"#3b82f6", borderRadius:"6px", fontSize:'13px', fontWeight:'600', display:'flex', alignItems:'center', gap:'5px'}}>
                    <span>📂 Upload</span>
                    <input type="file" onChange={(e) => {if(e.target.files[0]) handleUpload(e.target.files[0]); e.target.value=null;}} accept=".pdf" style={{display: "none"}} />
                </label>
                
               {!user && <button onClick={() => setShowAuth(true)} style={{background:'transparent', border:'1px solid #3b82f6', color:'#3b82f6', padding:'7px 15px', borderRadius:'6px', cursor:'pointer', fontWeight:'bold', fontSize:'13px'}}>Login</button>}
          </div>
      </div>

      {/* --- MAIN BODY --- */}
      <div style={{flex:1, display:'flex', overflow:'hidden', position:'relative'}}>
          
          {/* 1. SIDEBAR (Collapsible) */}
          <div style={{
              width: isSidebarOpen ? (isMobile ? '100%' : '260px') : '0px', 
              background:'#1e293b', 
              borderRight:'1px solid #334155', 
              display:'flex', flexDirection:'column',
              transition: 'width 0.3s ease',
              overflow: 'hidden',
              position: isMobile ? 'absolute' : 'relative',
              zIndex: 100, height: '100%'
          }}>
             {user ? (
                 <>
                    <div style={{padding:'20px', borderBottom:'1px solid #334155', minWidth:'260px'}}>
                        <h3 style={{margin:0, color:'#38bdf8', fontSize:'13px', textTransform:'uppercase'}}>Your Documents</h3>
                    </div>
                    <div style={{flex:1, overflowY:'auto', padding:'10px', minWidth:'260px'}}>
                        {sessions.map(s => (
                        <div key={s.id} onClick={() => { loadChat(s); if(isMobile) setIsSidebarOpen(false); }}
                                style={{
                                padding:'12px', marginBottom:'5px', cursor:'pointer', borderRadius:'6px',
                                background: currentSessionId === s.id ? '#38bdf8' : 'transparent',
                                color: currentSessionId === s.id ? '#0f172a' : '#cbd5e1',
                                display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:'13px'
                                }}>
                            <span style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'190px'}}>📄 {s.pdf_name}</span>
                            <button onClick={(e) => deleteSession(e, s.id)} style={{background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:'16px'}}>×</button>
                        </div>
                        ))}
                    </div>
                    <div style={{padding:'15px', borderTop:'1px solid #334155', minWidth:'260px'}}>
                        <button onClick={() => {setUser(null); setMessages([]); setActivePdfUrl(null);}} style={{width:'100%', padding:'10px', background:'#ef4444', color:'white', border:'none', borderRadius:'6px', cursor:'pointer'}}>Sign Out</button>
                    </div>
                 </>
             ) : (
                 <div style={{padding:'20px', color:'#94a3b8', textAlign:'center', minWidth:'260px'}}>Please login to view history.</div>
             )}
          </div>

          {/* 2. CHAT AREA */}
          <div style={{
              flex: 1, 
              display: (isMobile && mobileTab !== 'chat') || isPdfFullScreen ? 'none' : 'flex', 
              flexDirection:'column', 
              borderRight: isMobile ? 'none' : '1px solid #334155',
              background:'#0f172a'
          }}>
                {/* Messages */}
                <div style={{flex:1, overflowY:'auto', padding:'20px'}}>
                    {messages.length === 0 && (
                        <div style={{textAlign:'center', marginTop:'20%', color:'#64748b'}}>
                            <div style={{fontSize:'40px', marginBottom:'10px'}}>👋</div>
                            <p>Upload a PDF to start.</p>
                        </div>
                    )}
                    {messages.map((msg, index) => (
                        <div key={index} style={{display:'flex', flexDirection:'column', alignItems: msg.role === "user" ? "flex-end" : "flex-start", marginBottom:"20px"}}>
                            <div style={{
                                maxWidth:"90%", padding:"12px 16px", borderRadius:"12px", fontSize:'14px', lineHeight:'1.5',
                                background: msg.role === "user" ? "#3b82f6" : "#1e293b", color: "#fff"
                            }}>
                                <div style={{whiteSpace:"pre-wrap"}}>{msg.content}</div>
                            </div>
                            {msg.sources && msg.sources.length > 0 && (
                                <div style={{marginTop:"5px", display:'flex', gap:'5px', flexWrap:'wrap', marginLeft: msg.role==='ai'?'5px':0}}>
                                    {msg.sources.map((s, i) => (
                                        <button key={i} onClick={() => handleCitationClick(s.filename, s.page)}
                                            style={{fontSize:'10px', background:'#334155', color:'#38bdf8', padding:'2px 8px', borderRadius:'4px', border:'1px solid #475569', cursor:'pointer'}}
                                        >
                                            Pg {s.page}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div style={{padding:'15px', background:'#1e293b', borderTop:'1px solid #334155'}}>
                    <div style={{display:'flex', gap:'8px', marginBottom:'10px', overflowX:'auto', paddingBottom:'2px'}}>
                        {quickActions.map((action, i) => (
                            <button key={i} onClick={() => askAI(action.prompt)} style={{
                                padding:'6px 12px', background:'rgba(255,255,255,0.05)', border:'1px solid #334155', 
                                borderRadius:'15px', color:'#94a3b8', fontSize:'11px', cursor:'pointer', whiteSpace:'nowrap'
                            }}>{action.label}</button>
                        ))}
                    </div>
                    <div style={{display:'flex', gap:'10px'}}>
                        <input value={question} onChange={e => setQuestion(e.target.value)} onKeyPress={e => e.key === 'Enter' && askAI()}
                            placeholder="Ask a question..." 
                            style={{flex:1, padding:'12px', borderRadius:'8px', border:'1px solid #334155', background:'#0f172a', color:'white', outline:'none'}}
                        />
                        <button onClick={() => askAI()} disabled={loading} style={{padding:'0 20px', background:'#3b82f6', border:'none', borderRadius:'8px', color:'white', fontWeight:'bold', cursor:'pointer'}}>Send</button>
                    </div>
                </div>
          </div>

          {/* 3. PDF VIEWER */}
          <div style={{
              flex: isPdfFullScreen ? 1 : 1.2, // Take more space or full space
              display: (isMobile && mobileTab !== 'pdf') && !isPdfFullScreen ? 'none' : 'flex', 
              flexDirection:'column', 
              background:'#0f172a',
              borderLeft:'1px solid #000'
          }}>
              <div style={{
                  padding:'8px 20px', background:'#1e293b', borderBottom:'1px solid #334155', 
                  display:'flex', justifyContent:'space-between', alignItems:'center'
              }}>
                  <span style={{color:'#94a3b8', fontSize:'12px', fontWeight:'bold', letterSpacing:'1px'}}>DOCUMENT VIEWER</span>
                  <div style={{display:'flex', gap:'10px'}}>
                      {!isMobile && (
                          <button onClick={() => setIsPdfFullScreen(!isPdfFullScreen)} style={{background:'none', border:'none', color:'#38bdf8', fontSize:'12px', cursor:'pointer'}}>
                              {isPdfFullScreen ? "⭯ Split View" : "⛶ Full Screen"}
                          </button>
                      )}
                      {activePdfUrl && <a href={activePdfUrl} target="_blank" rel="noreferrer" style={{color:'#94a3b8', textDecoration:'none', fontSize:'12px'}}>New Tab ↗</a>}
                  </div>
              </div>
              
              {activePdfUrl ? (
                  <iframe src={activePdfUrl} style={{width:'100%', flex:1, border:'none', background:'white'}} title="PDF Viewer" />
              ) : (
                  <div style={{flex:1, display:'flex', justifyContent:'center', alignItems:'center', color:'#334155', flexDirection:'column'}}>
                      <div style={{fontSize:'40px', marginBottom:'10px'}}>📄</div>
                      <div>Select a document to view</div>
                  </div>
              )}
          </div>
      </div>

      {/* --- MOBILE BOTTOM TABS (Visible only on Mobile) --- */}
      {isMobile && (
          <div style={{
              height:'60px', background:'#1e293b', borderTop:'1px solid #334155', 
              display:'flex', justifyContent:'space-around', alignItems:'center', flexShrink: 0
          }}>
              <button onClick={() => setMobileTab('chat')} style={{background:'none', border:'none', color: mobileTab==='chat'?'#38bdf8':'#94a3b8', fontSize:'14px', display:'flex', flexDirection:'column', alignItems:'center'}}>
                  <span style={{fontSize:'18px'}}>💬</span>
                  Chat
              </button>
              <button onClick={() => setMobileTab('pdf')} style={{background:'none', border:'none', color: mobileTab==='pdf'?'#38bdf8':'#94a3b8', fontSize:'14px', display:'flex', flexDirection:'column', alignItems:'center'}}>
                  <span style={{fontSize:'18px'}}>📄</span>
                  Document
              </button>
          </div>
      )}

      {/* --- AUTH MODAL --- */}
      {showAuth && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'flex', justifyContent:'center', alignItems:'center', zIndex:2000}}>
            <div style={{background:'#1e293b', padding:'30px', borderRadius:'12px', width:'300px', border:'1px solid #334155'}}>
                <h2 style={{marginTop:0}}>{isLogin?"Login":"Register"}</h2>
                <input placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} style={{width:'100%', padding:'10px', marginBottom:'10px', background:'#0f172a', border:'1px solid #334155', color:'white'}} />
                <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} style={{width:'100%', padding:'10px', marginBottom:'20px', background:'#0f172a', border:'1px solid #334155', color:'white'}} />
                <button onClick={handleAuth} style={{width:'100%', padding:'10px', background:'#3b82f6', color:'white', border:'none', borderRadius:'6px', cursor:'pointer'}}>{isLogin?"Login":"Register"}</button>
                <button onClick={()=>setShowAuth(false)} style={{width:'100%', marginTop:'10px', background:'none', color:'#64748b', border:'none', cursor:'pointer'}}>Cancel</button>
                <div style={{textAlign:'center', marginTop:'15px', color:'#38bdf8', cursor:'pointer', fontSize:'12px'}} onClick={()=>setIsLogin(!isLogin)}>{isLogin?"Create Account":"Login Instead"}</div>
            </div>
        </div>
      )}
    </div>
  );
}

export default App; 