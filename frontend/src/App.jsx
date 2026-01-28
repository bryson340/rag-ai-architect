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
  
  // UI States
  const [toast, setToast] = useState(null); 
  const [showAuth, setShowAuth] = useState(false);
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  
  // Responsive States
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState('chat'); 
  const [isPdfFullScreen, setIsPdfFullScreen] = useState(false); 
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  const chatEndRef = useRef(null);

  const quickActions = [
    { label: "📝 Summarize", prompt: "Summarize this document in 5 concise bullet points." },
    { label: "⚠️ Risks", prompt: "Identify potential risks, warnings, or negative clauses." },
    { label: "📅 Dates", prompt: "List all important dates, deadlines, and timelines." },
  ];

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth < 768) setIsSidebarOpen(false); 
      else setIsSidebarOpen(true);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, mobileTab]);

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
    if (!user) return;
    try {
      const res = await axios.get(`http://localhost:8000/sessions/${user.user_id}`);
      setSessions(res.data);
    } catch (e) { console.error(e); }
  };

  const loadChat = async (session) => {
    setCurrentSessionId(session.id);
    const safeFilename = encodeURIComponent(session.pdf_name);
    setActivePdfUrl(`http://localhost:8000/static/${safeFilename}`);
    
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
      console.log("Upload Response:", res.data); // DIAGNOSTIC LOG
      
      showToast("✅ Upload Successful!", "success");
      setMessages([]); 
      
      if (res.data.session_id) {
        if (user) await loadSessions();
        
        setCurrentSessionId(res.data.session_id);
        
        // FIX: Check for filename OR pdf_name to prevent 'undefined'
        const fname = res.data.filename || res.data.pdf_name;
        if (fname) {
            const safeFilename = encodeURIComponent(fname);
            setActivePdfUrl(`http://localhost:8000/static/${safeFilename}`);
        } else {
             console.error("No filename found in response!", res.data);
        }
        
        if (isMobile) setMobileTab('pdf');
      }
    } catch (error) { 
      console.error(error);
      showToast("❌ Upload Failed.", "error"); 
    }
  };

  const clearChat = () => {
      if(window.confirm("Clear current conversation?")) {
          setMessages([]);
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
      if (isMobile) setMobileTab('pdf');
      const safeFilename = encodeURIComponent(filename);
      const newUrl = `http://localhost:8000/static/${safeFilename}`;
      if (activePdfUrl?.split('#')[0] !== newUrl) setActivePdfUrl(newUrl);
      setTimeout(() => setActivePdfUrl(`${newUrl}#page=${page}`), 100);
  };

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100vh', width:'100vw', background:'#0f172a', color:'white', fontFamily:'"Inter", sans-serif', overflow:'hidden'}}>
      
      {/* TOAST */}
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

      {/* HEADER */}
      <div style={{
          height:'60px', background:'#1e293b', borderBottom:'1px solid #334155', 
          display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 25px', flexShrink: 0
      }}>
          <div style={{display:'flex', alignItems:'center', gap:'15px'}}>
              <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={{background:'none', border:'none', color:'white', fontSize:'22px', cursor:'pointer', padding:'5px'}}>
                  ☰
              </button>
              
              <div style={{fontWeight:'700', fontSize:'18px', display:'flex', alignItems:'center', gap:'10px'}}>
                  <span style={{fontSize:'22px'}}>🧠</span> 
                  {!isMobile && <span>RAG Architect</span>}
              </div>
          </div>

          <div style={{display:'flex', gap:'15px', alignItems:'center'}}>
               <label style={{cursor:"pointer", padding:"8px 18px", background:"#3b82f6", borderRadius:"6px", fontSize:'13px', fontWeight:'600', display:'flex', alignItems:'center', gap:'8px', transition: 'all 0.2s'}}>
                    <span>📂 Upload PDF</span>
                    <input type="file" onChange={(e) => {if(e.target.files[0]) handleUpload(e.target.files[0]); e.target.value=null;}} accept=".pdf,.txt" style={{display: "none"}} />
                </label>
                
               {!user && <button onClick={() => setShowAuth(true)} style={{background:'transparent', border:'1px solid #3b82f6', color:'#3b82f6', padding:'7px 15px', borderRadius:'6px', cursor:'pointer', fontWeight:'bold', fontSize:'13px'}}>Login</button>}
          </div>
      </div>

      {/* BODY */}
      <div style={{flex:1, display:'flex', overflow:'hidden', position:'relative', width: '100%'}}>
          
          {/* SIDEBAR */}
          <div style={{
              width: isSidebarOpen ? (isMobile ? '100%' : '280px') : '0px', 
              background:'#1e293b', 
              borderRight:'1px solid #334155', 
              display:'flex', flexDirection:'column',
              transition: 'width 0.3s ease',
              overflow: 'hidden',
              position: isMobile ? 'absolute' : 'relative',
              zIndex: 100, height: '100%',
              flexShrink: 0
          }}>
             {user ? (
                 <>
                    <div style={{padding:'25px 20px', borderBottom:'1px solid #334155'}}>
                        <h3 style={{margin:0, color:'#38bdf8', fontSize:'13px', textTransform:'uppercase', letterSpacing:'1px'}}>Your Documents</h3>
                    </div>
                    <div style={{flex:1, overflowY:'auto', padding:'15px'}}>
                        {sessions.map(s => (
                        <div key={s.id} onClick={() => { loadChat(s); if(isMobile) setIsSidebarOpen(false); }}
                                style={{
                                padding:'12px 15px', marginBottom:'8px', cursor:'pointer', borderRadius:'8px',
                                background: currentSessionId === s.id ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                                color: currentSessionId === s.id ? '#38bdf8' : '#94a3b8',
                                display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:'14px',
                                border: currentSessionId === s.id ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid transparent'
                                }}>
                            <span style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'180px', fontWeight: currentSessionId===s.id?'600':'400'}}>📄 {s.pdf_name}</span>
                            <button onClick={(e) => deleteSession(e, s.id)} style={{background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:'18px', padding:'0 5px'}}>×</button>
                        </div>
                        ))}
                    </div>
                    <div style={{padding:'20px', borderTop:'1px solid #334155', background:'#1a2639'}}>
                        <div style={{display:'flex', alignItems:'center', gap:'10px', marginBottom:'15px', paddingLeft:'5px'}}>
                            <div style={{width:'8px', height:'8px', borderRadius:'50%', background:'#10b981'}}></div>
                            <span style={{fontSize:'13px', color:'#cbd5e1'}}>{user.username}</span>
                        </div>
                        <button onClick={() => {setUser(null); setMessages([]); setActivePdfUrl(null);}} style={{width:'100%', padding:'12px', background:'#ef4444', color:'white', border:'none', borderRadius:'8px', cursor:'pointer', fontWeight:'600'}}>Sign Out</button>
                    </div>
                 </>
             ) : (
                 <div style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'#64748b', padding:'20px', textAlign:'center'}}>
                     <div style={{fontSize:'30px', marginBottom:'10px'}}>👋</div>
                     <h3 style={{color:'white', margin:'0 0 10px 0'}}>Guest Mode</h3>
                     <p style={{fontSize:'13px', margin:0}}>
                        You can chat with documents, but your history won't be saved.
                     </p>
                     <button onClick={() => setShowAuth(true)} style={{marginTop:'20px', padding:'10px 20px', background:'#334155', color:'white', border:'1px solid #475569', borderRadius:'8px', cursor:'pointer'}}>Login to Save</button>
                </div>
             )}
          </div>

          {/* CHAT AREA */}
          <div style={{
              flex: 1, 
              display: (isMobile && mobileTab !== 'chat') || isPdfFullScreen ? 'none' : 'flex', 
              flexDirection:'column', 
              borderRight: isMobile ? 'none' : '1px solid #334155',
              background:'#0f172a',
              minWidth: '350px'
          }}>
                {/* Clear Chat Button */}
                <div style={{
                    padding:'10px 20px', 
                    borderBottom:'1px solid #334155', 
                    display:'flex', justifyContent:'flex-end',
                    background: '#162032'
                }}>
                    <button 
                        onClick={clearChat}
                        style={{
                            background:'transparent', border:'1px solid #475569', color:'#94a3b8', 
                            padding:'6px 12px', borderRadius:'6px', cursor:'pointer', fontSize:'12px',
                            display: 'flex', alignItems: 'center', gap: '5px'
                        }}
                    >
                        <span>🧹</span> Clear Chat
                    </button>
                </div>

                {/* Messages */}
                <div style={{flex:1, overflowY:'auto', padding:'25px 30px'}}>
                    {messages.length === 0 && (
                        <div style={{textAlign:'center', marginTop:'15%', color:'#64748b'}}>
                            <div style={{fontSize:'60px', marginBottom:'20px'}}>👋</div>
                            <p style={{fontSize:'18px', fontWeight:'500'}}>Welcome {user ? user.username : "Guest"}</p>
                            <p style={{fontSize:'14px', marginTop:'5px'}}>Upload a PDF to start asking questions.</p>
                        </div>
                    )}
                    {messages.map((msg, index) => (
                        <div key={index} style={{display:'flex', flexDirection:'column', alignItems: msg.role === "user" ? "flex-end" : "flex-start", marginBottom:"25px"}}>
                            <div style={{
                                maxWidth:"85%", padding:"15px 20px", borderRadius:"15px", fontSize:'15px', lineHeight:'1.6',
                                background: msg.role === "user" ? "#3b82f6" : "#1e293b", color: "#fff",
                                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                            }}>
                                <div style={{whiteSpace:"pre-wrap"}}>{msg.content}</div>
                            </div>
                            {msg.sources && msg.sources.length > 0 && (
                                <div style={{marginTop:"8px", display:'flex', gap:'8px', flexWrap:'wrap', marginLeft: msg.role==='ai'?'5px':0}}>
                                    {msg.sources.map((s, i) => (
                                        <button key={i} onClick={() => handleCitationClick(s.filename, s.page)}
                                            style={{fontSize:'11px', background:'#334155', color:'#38bdf8', padding:'4px 10px', borderRadius:'15px', border:'1px solid #475569', cursor:'pointer'}}
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

                {/* Input Area */}
                <div style={{padding:'20px 30px', background:'#1e293b', borderTop:'1px solid #334155'}}>
                    <div style={{display:'flex', gap:'10px', marginBottom:'15px', overflowX:'auto', paddingBottom:'5px'}}>
                        {quickActions.map((action, i) => (
                            <button key={i} onClick={() => askAI(action.prompt)} style={{
                                padding:'8px 16px', background:'rgba(255,255,255,0.05)', border:'1px solid #334155', 
                                borderRadius:'20px', color:'#94a3b8', fontSize:'12px', cursor:'pointer', whiteSpace:'nowrap', transition:'all 0.2s'
                            }}
                            onMouseOver={(e) => {e.target.style.background='#38bdf8'; e.target.style.color='white'}}
                            onMouseOut={(e) => {e.target.style.background='rgba(255,255,255,0.05)'; e.target.style.color='#94a3b8'}}
                            >{action.label}</button>
                        ))}
                    </div>
                    <div style={{display:'flex', gap:'15px', position:'relative'}}>
                        <input value={question} onChange={e => setQuestion(e.target.value)} onKeyPress={e => e.key === 'Enter' && askAI()}
                            placeholder="Ask a question about your documents..." 
                            style={{flex:1, padding:'16px 20px', borderRadius:'12px', border:'1px solid #334155', background:'#0f172a', color:'white', outline:'none', fontSize:'15px', boxShadow:'inset 0 2px 4px rgba(0,0,0,0.2)'}}
                        />
                        <button onClick={() => askAI()} disabled={loading} style={{padding:'0 25px', background: loading ? '#64748b' : 'linear-gradient(135deg, #38bdf8, #3b82f6)', border:'none', borderRadius:'12px', color:'white', fontWeight:'bold', cursor: loading?'wait':'pointer', fontSize:'15px', boxShadow:'0 4px 12px rgba(59, 130, 246, 0.3)'}}>
                            {loading ? "..." : "Send"}
                        </button>
                    </div>
                </div>
          </div>

          {/* PDF VIEWER */}
          <div style={{
              flex: isPdfFullScreen ? 1 : 1.5, 
              display: (isMobile && mobileTab !== 'pdf') && !isPdfFullScreen ? 'none' : 'flex', 
              flexDirection:'column', 
              background:'#0f172a',
              borderLeft:'1px solid #000'
          }}>
              <div style={{
                  padding:'12px 25px', background:'#1e293b', borderBottom:'1px solid #334155', 
                  display:'flex', justifyContent:'space-between', alignItems:'center'
              }}>
                  <span style={{color:'#94a3b8', fontSize:'12px', fontWeight:'700', letterSpacing:'1px', textTransform:'uppercase'}}>Document Viewer</span>
                  <div style={{display:'flex', gap:'15px'}}>
                      {!isMobile && (
                          <button onClick={() => setIsPdfFullScreen(!isPdfFullScreen)} style={{background:'none', border:'none', color:'#38bdf8', fontSize:'13px', cursor:'pointer', fontWeight:'500'}}>
                              {isPdfFullScreen ? "⭯ Split View" : "⛶ Full Screen"}
                          </button>
                      )}
                      {activePdfUrl && <a href={activePdfUrl} target="_blank" rel="noreferrer" style={{color:'#94a3b8', textDecoration:'none', fontSize:'13px'}}>New Tab ↗</a>}
                  </div>
              </div>
              
              {activePdfUrl ? (
                  <iframe src={activePdfUrl} style={{width:'100%', flex:1, border:'none', background:'white'}} title="PDF Viewer" />
              ) : (
                  <div style={{flex:1, display:'flex', justifyContent:'center', alignItems:'center', color:'#334155', flexDirection:'column'}}>
                      <div style={{fontSize:'50px', marginBottom:'15px'}}>📄</div>
                      <div style={{fontSize:'14px'}}>Select a document to view</div>
                  </div>
              )}
          </div>
      </div>

      {/* MOBILE TABS */}
      {isMobile && (
          <div style={{
              height:'60px', background:'#1e293b', borderTop:'1px solid #334155', 
              display:'flex', justifyContent:'space-around', alignItems:'center', flexShrink: 0
          }}>
              <button onClick={() => setMobileTab('chat')} style={{background:'none', border:'none', color: mobileTab==='chat'?'#38bdf8':'#94a3b8', fontSize:'14px', display:'flex', flexDirection:'column', alignItems:'center'}}>
                  <span style={{fontSize:'18px', marginBottom:'2px'}}>💬</span>
                  Chat
              </button>
              <button onClick={() => setMobileTab('pdf')} style={{background:'none', border:'none', color: mobileTab==='pdf'?'#38bdf8':'#94a3b8', fontSize:'14px', display:'flex', flexDirection:'column', alignItems:'center'}}>
                  <span style={{fontSize:'18px', marginBottom:'2px'}}>📄</span>
                  Document
              </button>
          </div>
      )}

      {/* AUTH MODAL */}
      {showAuth && (
        <div style={{position:'fixed', inset:0, background:'rgba(15, 23, 42, 0.8)', backdropFilter:'blur(5px)', display:'flex', justifyContent:'center', alignItems:'center', zIndex:2000}}>
            <div style={{background:'#1e293b', padding:'35px', borderRadius:'15px', width:'340px', border:'1px solid #334155', boxShadow:'0 20px 25px -5px rgba(0, 0, 0, 0.3)'}}>
                <div style={{textAlign:'center', marginBottom:'25px'}}>
                    <div style={{fontSize:'40px', marginBottom:'10px'}}>🔐</div>
                    <h2 style={{margin:0, color:'white'}}>{isLogin?"Welcome Back":"Create Account"}</h2>
                </div>
                
                <input placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} style={{width:'100%', padding:'14px', marginBottom:'12px', background:'#0f172a', border:'1px solid #334155', color:'white', borderRadius:'8px', outline:'none', boxSizing:'border-box'}} />
                <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} style={{width:'100%', padding:'14px', marginBottom:'25px', background:'#0f172a', border:'1px solid #334155', color:'white', borderRadius:'8px', outline:'none', boxSizing:'border-box'}} />
                
                <button onClick={handleAuth} style={{width:'100%', padding:'14px', background:'#3b82f6', color:'white', border:'none', borderRadius:'8px', cursor:'pointer', fontWeight:'bold', fontSize:'15px'}}>{isLogin?"Login":"Sign Up"}</button>
                <button onClick={()=>setShowAuth(false)} style={{width:'100%', marginTop:'12px', background:'transparent', color:'#94a3b8', border:'none', cursor:'pointer'}}>Cancel</button>
                
                <div style={{textAlign:'center', marginTop:'20px', color:'#38bdf8', cursor:'pointer', fontSize:'13px', fontWeight:'500'}} onClick={()=>setIsLogin(!isLogin)}>{isLogin?"Need an account? Sign Up":"Already have an account? Login"}</div>
            </div>
        </div>
      )}
    </div>
  );
}

export default App;