"use client";

import { useState, useRef, useEffect } from "react";

type LogEntry = {
  id: number;
  message: string;
  type: "info" | "success" | "error" | "warning";
};

export default function Home() {
  const [subdomain, setSubdomain] = useState("");
  const [token, setToken] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [duplicatesCount, setDuplicatesCount] = useState<number | null>(null);
  const [mode, setMode] = useState<"contacts" | "leads" | "cleanup">("contacts");
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string>("");
  const [statusMap, setStatusMap] = useState<Record<number, number>>({});
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef(false);

  // Limpeza States
  const [cleanupCreatedValue, setCleanupCreatedValue] = useState("1");
  const [cleanupCreatedUnit, setCleanupCreatedUnit] = useState("years");
  const [cleanupInteractionValue, setCleanupInteractionValue] = useState("6");
  const [cleanupInteractionUnit, setCleanupInteractionUnit] = useState("months");
  const [cleanupTag, setCleanupTag] = useState("Para_Exclusao");
  const [cleanupLeads, setCleanupLeads] = useState<any[]>([]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { id: Date.now() + Math.random(), message, type }]);
  };

  const handleStop = () => {
    stopRef.current = true;
    abortRef.current?.abort();
    addLog("Interrupção solicitada. Aguardando o lote atual finalizar...", "warning");
  };

  const normalizePhone = (digitsOnly: string) => {
    // Normalizador Robusto: Trata DDI, DDD, Nono Dígito e Zeros à esquerda
    let cleaned = digitsOnly;
    
    // 1. Remover 55 se existir (Brasil) e o número for longo o suficiente
    if (cleaned.length >= 12 && cleaned.startsWith("55")) {
      cleaned = cleaned.slice(2);
    }
    
    // 2. Remover zero à esquerda (comum em DDDs salvos manualmente)
    while (cleaned.startsWith("0")) {
      cleaned = cleaned.slice(1);
    }
    
    // 3. Tratar nono dígito em números com DDD (Total 11 dígitos: DD 9XXXXXXXX)
    // No Brasil, o nono dígito sempre é 9. Removemos para comparar com a versão de 8 dígitos.
    if (cleaned.length === 11 && cleaned.charAt(2) === "9") {
      cleaned = cleaned.slice(0, 2) + cleaned.slice(3);
    }
    
    // 4. Tratar nono dígito em números SEM DDD (Total 9 dígitos: 9XXXXXXXX)
    if (cleaned.length === 9 && cleaned.startsWith("9")) {
      cleaned = cleaned.slice(1);
    }
    
    return cleaned;
  };

  const getPhoneFromEntity = (entity: any) => {
    // Se já tivermos telefones coletados (enriquecimento para Leads)
    if (entity.collected_phones && entity.collected_phones.length > 0) {
      return entity.collected_phones;
    }

    // Se for contato direto ou lead com campos injetados
    if (entity.custom_fields_values) {
      // 1. Tentar campo padrão PHONE
      const phoneField = entity.custom_fields_values.find((f: any) => f.field_code === "PHONE");
      if (phoneField?.values) {
        return phoneField.values.map((v: any) => v.value).filter(Boolean);
      }

      // 2. Fallback: Buscar qualquer campo que tenha "telefone", "celular" ou "whatsapp" no nome
      const anyPhoneField = entity.custom_fields_values.filter((f: any) => {
        const name = (f.field_name || "").toLowerCase();
        return name.includes("tel") || name.includes("cel") || name.includes("whatsapp") || name.includes("contato");
      });

      if (anyPhoneField.length > 0) {
        const collected: string[] = [];
        anyPhoneField.forEach((f: any) => {
          f.values?.forEach((v: any) => {
            if (v.value) collected.push(v.value);
          });
        });
        if (collected.length > 0) return collected;
      }
    }

    // Se for Lead (tentativa fallback se não houver enriquecimento ainda)
    if (entity._embedded?.contacts) {
      const phones: string[] = [];
      entity._embedded.contacts.forEach((c: any) => {
        // Recursivo para o contato vinculado
        const contactPhones = getPhoneFromEntity(c);
        contactPhones.forEach((p: string) => {
          if (!phones.includes(p)) phones.push(p);
        });
      });
      return phones;
    }
    return [];
  };

  const findDuplicates = (entities: any[]) => {
    const groups: Record<string, any[]> = {};
    for (const entity of entities) {
      // 1. Agrupar por Telefone (Busca ampla)
      const phones = getPhoneFromEntity(entity);
      for (const rawPhone of phones) {
        const digitsOnly = rawPhone.replace(/\D/g, "");
        if (!digitsOnly) continue;
        
        const standardPhone = normalizePhone(digitsOnly);
        if (!groups[standardPhone]) groups[standardPhone] = [];
        if (!groups[standardPhone].find((e) => e.id === entity.id)) {
          groups[standardPhone].push(entity);
        }
      }

      // 2. Agrupar por ID do Contato (Busca precisa: Vários leads no mesmo contato)
      const contactIds = entity._embedded?.contacts?.map((c: any) => c.id) || [];
      for (const cid of contactIds) {
        const key = `contact_${cid}`;
        if (!groups[key]) groups[key] = [];
        if (!groups[key].find((e) => e.id === entity.id)) {
          groups[key].push(entity);
        }
      }
    }
    return Object.values(groups).filter(g => g.length > 1);
  };

  const [contactGroups, setContactGroups] = useState<any[][]>([]);
  const [showSample, setShowSample] = useState(false);

  const calculateScore = (entity: any) => {
    const tags = entity._embedded?.tags?.length || 0;
    const fields = entity.custom_fields_values?.length || 0;
    
    // INTELIGÊNCIA DE CONVERSA REAL
    // is_unanswered_chat: prioridade máxima absoluta (alguém está esperando no chat)
    const hasOpenChat = entity.is_unanswered_chat === true;
    
    // last_incoming_message_at: bônus por interação recente (quem falou por último ganha)
    // Dividimos por 100.000 para transformar o timestamp em uma pontuação incremental que não quebre o teto
    const recencyBonus = entity.last_incoming_message_at ? (entity.last_incoming_message_at / 100000) : 0;
    
    const chatBonus = (hasOpenChat ? 20000 : 0) + recencyBonus;

    if (mode === "contacts") {
      const leads = entity._embedded?.leads?.length || 0;
      return chatBonus + (tags * 1) + (fields * 1) + (leads * 10);
    } else {
      // Para Leads, priorizamos o status e a conversa
      const contactCount = entity._embedded?.contacts?.length || 0;
      const statusOrder = statusMap[entity.status_id] || 0;
      
      return chatBonus + (statusOrder * 100) + (tags * 1) + (fields * 1) + (contactCount * 5);
    }
  };

  const fetchPipelines = async () => {
    if (!subdomain || !token) return;
    try {
      const res = await fetch(`/api/pipelines?subdomain=${subdomain}&token=${token}`);
      const data = await res.json();
      if (data.pipelines) {
        setPipelines(data.pipelines);
        if (data.pipelines.length > 0) {
          const firstPipe = data.pipelines[0];
          setSelectedPipeline(firstPipe.id.toString());
          
          // Mapear ordem dos status (baseado no sort)
          const sm: Record<number, number> = {};
          const sortedStatuses = [...(firstPipe._embedded?.statuses || [])].sort((a, b) => a.sort - b.sort);
          sortedStatuses.forEach((s, idx) => {
            sm[s.id] = idx;
          });
          setStatusMap(sm);
        }
        addLog("Funis carregados com sucesso.", "success");
      }
    } catch (err) {
      addLog("Erro ao carregar funis.", "error");
    }
  };

  const handleAction = async (action: "analyze" | "merge") => {
    if (!subdomain || !token) {
      addLog("Por favor, preencha o subdomínio e o token.", "error");
      return;
    }

    setIsRunning(true);
    setStatus("running");
    stopRef.current = false;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    if (action === "analyze") {
      setLogs([]);
      setDuplicatesCount(null);
      setHasAnalyzed(false);
      setContactGroups([]);
      addLog("Iniciando varredura controlada (Pelas limitações da Cloudflare)...", "info");

      try {
        let page = 1;
        let allItems: any[] = [];
        let hasMore = true;

        const endpoint = mode === "contacts" ? "/api/contacts" : "/api/contacts"; // Reutilizando proxy
        const queryParams = `?subdomain=${subdomain}&token=${token}&page=${page}${mode === 'leads' ? `&pipeline_id=${selectedPipeline}&entity=leads` : ''}`;

        while (hasMore) {
          if (stopRef.current) { addLog("Busca interrompida pelo usuário.", "warning"); break; }
          addLog(`Buscando ${mode === 'contacts' ? 'contatos' : 'leads'}, página ${page}...`);
          const url = `/api/contacts?subdomain=${subdomain}&token=${token}&page=${page}${mode === 'leads' ? `&pipeline_id=${selectedPipeline}&entity=leads` : ''}`;
          const res = await fetch(url, { signal });
          if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.error || "Erro ao buscar dados");
          }
          const data = await res.json();
          allItems = allItems.concat(data.contacts || data.leads || []);
          hasMore = data.hasMore;
          if (hasMore) page++;
        }

        addLog(`Busca finalizada. Total: ${allItems.length}`, "success");

        if (mode === 'leads') {
          addLog("Iniciando enriquecimento de dados (Buscando telefones dos contatos vinculados)...", "info");
          
          const contactIds = new Set<number>();
          allItems.forEach(item => {
            item._embedded?.contacts?.forEach((c: any) => contactIds.add(c.id));
          });

          const idsArray = Array.from(contactIds);
          const contactMap = new Map<number, string[]>();

          if (idsArray.length > 0) {
            const batchSize = 250;
            for (let i = 0; i < idsArray.length; i += batchSize) {
              if (stopRef.current) { addLog("Enriquecimento interrompido pelo usuário.", "warning"); break; }
              const batch = idsArray.slice(i, i + batchSize);
              addLog(`Enriquecendo telefones: Lote ${Math.floor(i/batchSize) + 1} de ${Math.ceil(idsArray.length/batchSize)}...`);

              const res = await fetch(`/api/contacts?subdomain=${subdomain}&token=${token}&ids=${batch.join(",")}`, { signal });
              if (res.ok) {
                const data = await res.json();
                (data.contacts || []).forEach((c: any) => {
                  // Usar a mesma lógica flexível de busca de telefone
                  let phones = [];
                  const phoneField = c.custom_fields_values?.find((f: any) => f.field_code === "PHONE");
                  if (phoneField?.values) {
                    phones = phoneField.values.map((v: any) => v.value).filter(Boolean);
                  } else if (c.custom_fields_values) {
                    // Fallback para campos similares
                    const anyPhone = c.custom_fields_values.filter((f: any) => {
                      const name = (f.field_name || "").toLowerCase();
                      return name.includes("tel") || name.includes("cel") || name.includes("whatsapp");
                    });
                    phones = anyPhone.flatMap((f: any) => f.values?.map((v: any) => v.value) || []).filter(Boolean);
                  }
                  contactMap.set(c.id, phones);
                });
              }
            }

            // Injetar telefones nos leads
            allItems.forEach(lead => {
              const phones = new Set<string>();
              lead._embedded?.contacts?.forEach((c: any) => {
                const results = contactMap.get(c.id) || [];
                results.forEach(p => phones.add(p));
              });
              lead.collected_phones = Array.from(phones);
            });
            addLog("Enriquecimento concluído.", "success");
          }
        }

        addLog("Iniciando análise de duplicidade...", "info");
        
        const duplicates = findDuplicates(allItems);
        
        // ORDENAR CADA GRUPO POR SCORE (O primeiro será o principal)
        const sortedGroups = duplicates.map(group => {
          return group.sort((a, b) => calculateScore(b) - calculateScore(a));
        });

        setContactGroups(sortedGroups);
        
        let totalDupCount = 0;
        sortedGroups.forEach(g => { totalDupCount += (g.length - 1); });
        
        setDuplicatesCount(totalDupCount);
        addLog(`Análise finalizada: ${totalDupCount} duplicados em ${sortedGroups.length} grupos.`, "success");
        setHasAnalyzed(true);
        setStatus("success");
        setIsRunning(false);
      } catch (error: any) {
        if (error.name === "AbortError" || stopRef.current) {
          addLog("Busca interrompida pelo usuário.", "warning");
          setStatus("idle");
        } else {
          addLog(`Erro na busca: ${error.message}`, "error");
          setStatus("error");
        }
        setIsRunning(false);
      }
    } else {
      addLog("Iniciando o processo definitivo de MERGE em lotes...", "warning");
      
      try {
        // Processar em lotes de 10 grupos para evitar timeouts e limites
        const batchSize = 3;
        for (let i = 0; i < contactGroups.length; i += batchSize) {
          if (stopRef.current) { addLog("Merge interrompido pelo usuário.", "warning"); break; }
          const batch = contactGroups.slice(i, i + batchSize);
          addLog(`Processando lote ${Math.floor(i/batchSize) + 1} de ${Math.ceil(contactGroups.length/batchSize)}...`, "info");

          const response = await fetch("/api/deduplicate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subdomain, token, groups: batch, entityType: mode }),
            signal,
          });

          if (!response.body) throw new Error("Sem resposta do servidor");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n").filter(l => l.trim() !== "");
            for (const line of lines) {
              const data = JSON.parse(line);
              addLog(data.message, data.type);
            }
          }
        }

        if (!stopRef.current) {
          addLog("Merge concluído com sucesso em todos os lotes!", "success");
          setStatus("success");
        }
      } catch (error: any) {
        if (error.name === "AbortError" || stopRef.current) {
          addLog("Merge interrompido pelo usuário.", "warning");
          setStatus("idle");
        } else {
          addLog(`Erro no merge: ${error.message}`, "error");
          setStatus("error");
        }
      } finally {
        setIsRunning(false);
      }
    }
  };

  const handleCleanupSearch = async () => {
    if (!subdomain || !token) {
      addLog("Por favor, preencha o subdomínio e o token.", "error");
      return;
    }
    setIsRunning(true);
    setStatus("running");
    stopRef.current = false;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setLogs([]);
    setCleanupLeads([]);
    addLog("Iniciando busca de leads inativos...", "info");

    const getSeconds = (val: string, unit: string) => {
      const num = parseInt(val) || 0;
      if (unit === "minutes") return num * 60;
      if (unit === "hours") return num * 3600;
      if (unit === "days") return num * 86400;
      if (unit === "months") return num * 2592000; // 30 days
      if (unit === "years") return num * 31536000; // 365 days
      return 0;
    };

    const now = Math.floor(Date.now() / 1000);
    const createdBefore = now - getSeconds(cleanupCreatedValue, cleanupCreatedUnit);
    const updatedBefore = now - getSeconds(cleanupInteractionValue, cleanupInteractionUnit);

    try {
      let page = 1;
      let allItems: any[] = [];
      let hasMore = true;

      while (hasMore) {
        if (stopRef.current) { addLog("Busca interrompida pelo usuário.", "warning"); break; }
        addLog(`Buscando leads inativos, página ${page}...`);
        const url = `/api/cleanup?subdomain=${subdomain}&token=${token}&page=${page}&createdBefore=${createdBefore}&updatedBefore=${updatedBefore}`;
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error("Erro ao buscar dados");
        const data = await res.json();
        allItems = allItems.concat(data.leads || []);
        hasMore = data.hasMore;
        if (hasMore) page++;
      }

      setCleanupLeads(allItems);
      addLog(`Busca finalizada. Encontrados ${allItems.length} leads inativos.`, "success");
      setHasAnalyzed(true);
      if (!stopRef.current) setStatus("success");
      else setStatus("idle");
    } catch (error: any) {
      if (error.name === "AbortError" || stopRef.current) {
        addLog("Busca interrompida pelo usuário.", "warning");
        setStatus("idle");
      } else {
        addLog(`Erro na busca: ${error.message}`, "error");
        setStatus("error");
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleCleanupTag = async () => {
    if (!cleanupLeads.length) return;
    setIsRunning(true);
    setStatus("running");
    stopRef.current = false;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    addLog(`Iniciando aplicação da tag "${cleanupTag}" em ${cleanupLeads.length} leads...`, "warning");

    try {
      const response = await fetch("/api/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain, token, leads: cleanupLeads, tagName: cleanupTag }),
        signal,
      });

      if (!response.body) throw new Error("Sem resposta do servidor");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        if (stopRef.current) { await reader.cancel(); addLog("Tagueamento interrompido pelo usuário.", "warning"); break; }
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(l => l.trim() !== "");
        for (const line of lines) {
          const data = JSON.parse(line);
          addLog(data.message, data.type);
        }
      }
      if (!stopRef.current) setStatus("success");
      else setStatus("idle");
    } catch (error: any) {
      if (error.name === "AbortError" || stopRef.current) {
        addLog("Tagueamento interrompido pelo usuário.", "warning");
        setStatus("idle");
      } else {
        addLog(`Erro ao aplicar tag: ${error.message}`, "error");
        setStatus("error");
      }
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ width: "100%", maxWidth: "800px", display: "flex", flexDirection: "column", gap: "24px" }}>
        
        <div style={{ textAlign: "center", marginBottom: "16px" }}>
          <h1 style={{ fontSize: "2.2rem", marginBottom: "8px", fontWeight: "700", background: "linear-gradient(to right, #818cf8, #34d399)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Kommo Inteligência
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "1.1rem" }}>
            Deduplicação profissional de Contatos e Negócios
          </p>
        </div>

        {/* SELETOR DE MODO */}
        <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", padding: "4px", borderRadius: "14px", border: "1px solid var(--panel-border)" }}>
          <button 
            onClick={() => setMode("contacts")}
            style={{ 
              flex: 1, padding: "12px", borderRadius: "11px", border: "none", cursor: "pointer", transition: "all 0.3s",
              background: mode === "contacts" ? "var(--primary)" : "transparent",
              color: mode === "contacts" ? "white" : "var(--text-muted)",
              fontWeight: mode === "contacts" ? "700" : "400"
            }}
          >
            📱 Contatos
          </button>
          <button 
            onClick={() => setMode("leads")}
            style={{ 
              flex: 1, padding: "12px", borderRadius: "11px", border: "none", cursor: "pointer", transition: "all 0.3s",
              background: mode === "leads" ? "var(--primary)" : "transparent",
              color: mode === "leads" ? "white" : "var(--text-muted)",
              fontWeight: mode === "leads" ? "700" : "400"
            }}
          >
            💼 Leads (Negócios)
          </button>
          <button 
            onClick={() => setMode("cleanup")}
            style={{ 
              flex: 1, padding: "12px", borderRadius: "11px", border: "none", cursor: "pointer", transition: "all 0.3s",
              background: mode === "cleanup" ? "var(--primary)" : "transparent",
              color: mode === "cleanup" ? "white" : "var(--text-muted)",
              fontWeight: mode === "cleanup" ? "700" : "400"
            }}
          >
            🧹 Limpeza
          </button>
        </div>

        {/* PAINEL DE CREDENCIAIS */}
        <div className="glass-panel" style={{ padding: "30px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid var(--panel-border)" }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
            </svg>
            <h2 style={{ fontSize: "1.2rem", fontWeight: "600", color: "#e2e8f0" }}>Painel de Configuração API</h2>
          </div>

          <div style={{ display: "grid", gap: "20px", gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <label className="input-label">Subdomínio Kommo</label>
              <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
                <input 
                  type="text" 
                  className="input-field" 
                  style={{ paddingRight: "100px" }}
                  placeholder="sua-empresa" 
                  value={subdomain} 
                  onChange={(e) => setSubdomain(e.target.value)} 
                  onBlur={(e) => {
                    const cleaned = e.target.value.replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "").trim();
                    setSubdomain(cleaned);
                  }}
                  disabled={isRunning}
                />
                <span style={{ position: "absolute", right: "14px", color: "var(--text-muted)", pointerEvents: "none", fontSize: "0.9rem" }}>
                  .kommo.com
                </span>
              </div>
            </div>
            <div>
              <label className="input-label">Token de Acesso (API Key)</label>
              <input 
                type="password" 
                className="input-field" 
                placeholder="Cole sua chave aqui..." 
                value={token} 
                onChange={(e) => setToken(e.target.value)} 
                disabled={isRunning}
              />
            </div>
          </div>

          {mode === "leads" && (
            <div style={{ marginTop: "20px", display: "grid", gap: "20px" }}>
              <div>
                <label className="input-label">Selecionar Funil (Pipeline)</label>
                <div style={{ display: "flex", gap: "10px" }}>
                  <select 
                    className="input-field" 
                    style={{ flex: 1 }}
                    value={selectedPipeline}
                    onChange={(e) => {
                      const pipeId = e.target.value;
                      setSelectedPipeline(pipeId);
                      // Atualizar mapa de status do funil selecionado
                      const pipe = pipelines.find(p => p.id.toString() === pipeId);
                      if (pipe) {
                        const sm: Record<number, number> = {};
                        const sortedStatuses = [...(pipe._embedded?.statuses || [])].sort((a, b) => a.sort - b.sort);
                        sortedStatuses.forEach((s, idx) => {
                          sm[s.id] = idx;
                        });
                        setStatusMap(sm);
                      }
                    }}
                    disabled={isRunning}
                  >
                    <option value="">Selecione um funil...</option>
                    {pipelines.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button 
                    onClick={fetchPipelines} 
                    className="btn" 
                    style={{ padding: "10px 15px", background: "rgba(255,255,255,0.05)", fontSize: "0.8rem" }}
                  >
                    🔄 Carregar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* PAINEL DE INTELIGÊNCIA (REGRAS) - VISÍVEL DESDE O INÍCIO */}
        {mode !== "cleanup" && (
        <div className="glass-panel" style={{ padding: "20px", background: "rgba(79, 70, 229, 0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <h3 style={{ fontSize: "1rem", color: "#e2e8f0", fontWeight: "600" }}>Inteligência de Fusão e Segurança</h3>
          </div>
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
            <div style={{ padding: "12px", background: "rgba(0,0,0,0.2)", borderRadius: "10px", border: "1px solid var(--panel-border)" }}>
              <h4 style={{ fontSize: "0.82rem", color: "var(--primary)", marginBottom: "6px" }}>Critério de Sobrevivência (Score):</h4>
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", lineHeight: "1.4" }}>
                {mode === 'contacts' ? (
                  <>
                    • <b>Negócios (Leads)</b> = 10 pts cada<br/>
                    • <b>Campos Preenchidos</b> = 1 pt cada<br/>
                    • <b>Tags Existentes</b> = 1 pt cada
                  </>
                ) : (
                  <>
                    • <b>Avanço no Funil</b> = Prioridade Máxima<br/>
                    • <b>Contatos Vinculados</b> = 5 pts cada<br/>
                    • <b>Campos Preenchidos</b> = 1 pt cada
                  </>
                )}
                <br/>O item com maior pontuação preserva os dados originais.
              </p>
            </div>
            
            <div style={{ padding: "12px", background: "rgba(16, 185, 129, 0.05)", borderRadius: "10px", border: "1px dashed var(--success)" }}>
              <h4 style={{ fontSize: "0.82rem", color: "var(--success)", marginBottom: "6px" }}>🛡️ Garantia de Preservação:</h4>
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", lineHeight: "1.4" }}>
                <b>Leads e Negócios NÃO são excluídos.</b> {mode === 'leads' ? 'Em modo Leads, o mais avançado no funil torna-se o principal e herda todos os contatos e tags dos outros.' : 'O sistema apenas unifica os vínculos para que todos os negócios apontem para o contato principal.'}
              </p>
            </div>
          </div>
        </div>
        )}

        {/* PAINEL DE LIMPEZA DE INATIVOS */}
        {mode === "cleanup" && (
          <div className="glass-panel" style={{ padding: "30px", background: "rgba(239, 68, 68, 0.05)", border: "1px solid rgba(239, 68, 68, 0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid var(--panel-border)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <h2 style={{ fontSize: "1.2rem", fontWeight: "600", color: "#e2e8f0" }}>Configuração de Limpeza de Leads</h2>
            </div>
            
            <div style={{ display: "grid", gap: "20px", gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <label className="input-label">Criado há mais de:</label>
                <div style={{ display: "flex", gap: "10px" }}>
                  <input type="number" className="input-field" value={cleanupCreatedValue} onChange={(e) => setCleanupCreatedValue(e.target.value)} disabled={isRunning} style={{ width: "80px" }} />
                  <select className="input-field" value={cleanupCreatedUnit} onChange={(e) => setCleanupCreatedUnit(e.target.value)} disabled={isRunning} style={{ flex: 1 }}>
                    <option value="minutes">Minutos</option>
                    <option value="hours">Horas</option>
                    <option value="days">Dias</option>
                    <option value="months">Meses</option>
                    <option value="years">Anos</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="input-label">Sem interação há mais de:</label>
                <div style={{ display: "flex", gap: "10px" }}>
                  <input type="number" className="input-field" value={cleanupInteractionValue} onChange={(e) => setCleanupInteractionValue(e.target.value)} disabled={isRunning} style={{ width: "80px" }} />
                  <select className="input-field" value={cleanupInteractionUnit} onChange={(e) => setCleanupInteractionUnit(e.target.value)} disabled={isRunning} style={{ flex: 1 }}>
                    <option value="minutes">Minutos</option>
                    <option value="hours">Horas</option>
                    <option value="days">Dias</option>
                    <option value="months">Meses</option>
                    <option value="years">Anos</option>
                  </select>
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <label className="input-label">Nome da Tag a ser aplicada:</label>
                <input type="text" className="input-field" value={cleanupTag} onChange={(e) => setCleanupTag(e.target.value)} disabled={isRunning} placeholder="Ex: Para_Exclusao" />
              </div>
            </div>
          </div>
        )}

        {/* PAINEL DE EXECUÇÃO */}
        <div className="glass-panel" style={{ padding: "30px" }}>
          
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid var(--panel-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>Status:</span>
              <span className={`status-badge status-${status}`}>
                {status === "idle" && "Aguardando Inicialização"}
                {status === "running" && "Processando automação..."}
                {status === "success" && "Finalizado"}
                {status === "error" && "Erro no Processo"}
              </span>

              {mode !== "cleanup" && duplicatesCount !== null && (
                <div style={{ marginLeft: "10px", padding: "6px 12px", background: "rgba(245, 158, 11, 0.15)", color: "#fcd34d", borderRadius: "20px", fontSize: "0.8rem", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                  </svg>
                  <span>{duplicatesCount} {mode === 'contacts' ? 'Contato(s)' : 'Negócio(s)'} Duplicado(s)</span>
                </div>
              )}
              {mode === "cleanup" && cleanupLeads.length > 0 && (
                <div style={{ marginLeft: "10px", padding: "6px 12px", background: "rgba(239, 68, 68, 0.15)", color: "#fca5a5", borderRadius: "20px", fontSize: "0.8rem", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                  <span>{cleanupLeads.length} Lead(s) Inativo(s)</span>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              {isRunning && (
                <button
                  className="btn"
                  onClick={handleStop}
                  style={{ background: "var(--error)", borderColor: "var(--error)", color: "white", display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                  </svg>
                  Parar
                </button>
              )}
              {mode === "cleanup" ? (
                <>
                  <button 
                    className="btn" 
                    style={{ background: "rgba(255, 255, 255, 0.1)", color: "white", border: "1px solid var(--panel-border)" }}
                    onClick={handleCleanupSearch} 
                    disabled={isRunning}
                  >
                    {isRunning && !hasAnalyzed ? <div className="loader"></div> : null}
                    Buscar Inativos
                  </button>

                  <button 
                    className="btn btn-primary" 
                    onClick={handleCleanupTag} 
                    disabled={isRunning || cleanupLeads.length === 0}
                    style={{ opacity: (cleanupLeads.length === 0 ? 0.5 : 1), background: "var(--error)", borderColor: "var(--error)" }}
                  >
                    {isRunning && cleanupLeads.length > 0 ? <div className="loader"></div> : null}
                    Taguear para Exclusão
                  </button>
                </>
              ) : (
                <>
                  <button 
                    className="btn" 
                    style={{ background: "rgba(255, 255, 255, 0.1)", color: "white", border: "1px solid var(--panel-border)" }}
                    onClick={() => handleAction("analyze")} 
                    disabled={isRunning}
                  >
                    {isRunning && !hasAnalyzed ? <div className="loader"></div> : null}
                    Buscar Duplicados
                  </button>

                  <button 
                    className="btn btn-primary" 
                    onClick={() => handleAction("merge")} 
                    disabled={isRunning || !hasAnalyzed}
                    style={{ opacity: (!hasAnalyzed ? 0.5 : 1) }}
                  >
                    {isRunning && hasAnalyzed ? <div className="loader"></div> : null}
                    Iniciar Merge de {mode === 'contacts' ? 'Contatos' : 'Leads'}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* PAINEL DE AMOSTRA (DYNAMIC) */}
          {mode !== "cleanup" && hasAnalyzed && contactGroups.length > 0 && (
            <div style={{ marginTop: "20px", animation: "fadeIn 0.5s ease-out" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
                <h3 style={{ fontSize: "1rem", color: "#94a3b8", display: "flex", alignItems: "center", gap: "8px" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                  </svg>
                  Amostra de {mode === 'contacts' ? 'Contatos' : 'Leads'} Duplicados
                </h3>
                <button 
                  onClick={() => setShowSample(!showSample)}
                  style={{ background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text-muted)", padding: "6px 12px", borderRadius: "8px", fontSize: "0.8rem", cursor: "pointer" }}
                >
                  {showSample ? "Ocultar Amostra" : "Ver Amostra de Duplicados"}
                </button>
              </div>

              {showSample && (
                <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: "12px", padding: "15px", border: "1px solid var(--panel-border)" }}>
                  <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "15px" }}> 
                    Exibindo os primeiros 5 grupos encontrados (Total: {contactGroups.length} grupos).
                    O contato destacado em <span style={{ color: "#4ade80" }}>Verde</span> foi eleito o <b>Principal</b> no merge.
                  </p>
                  
                  {contactGroups.slice(0, 5).map((group, idx) => {
                    const sortedGroup = [...group].sort((a, b) => calculateScore(b) - calculateScore(a));
                    const phones = getPhoneFromEntity(group[0]);
                    const phone = phones.length > 0 ? phones[0] : "Sem telefone";
                    
                    return (
                      <div key={idx} className="sample-card">
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px", borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: "8px" }}>
                          <span style={{ fontSize: "0.9rem", color: "var(--primary)", fontWeight: "600" }}>📱 {phone}</span>
                          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{group.length} {mode === 'contacts' ? 'contatos' : 'leads'} encontrados</span>
                        </div>
                        <div style={{ display: "grid", gap: "10px" }}>
                          {sortedGroup.map((c, cIdx) => {
                            const currentPipe = pipelines.find(p => p.id.toString() === selectedPipeline);
                            const statusName = currentPipe?._embedded?.statuses?.find((s: any) => s.id === c.status_id)?.name;
                            
                            return (
                              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div style={{ display: "flex", flexDirection: "column" }}>
                                  <span style={{ fontSize: "0.85rem", color: cIdx === 0 ? "#fff" : "#94a3b8", fontWeight: cIdx === 0 ? "500" : "400" }}>
                                    {cIdx === 0 ? "🏆 " : "👤 "} {c.name}
                                  </span>
                                  {mode === "leads" && statusName && (
                                    <span style={{ fontSize: "0.7rem", color: "var(--primary)", marginLeft: "24px" }}>
                                      📍 Status: {statusName}
                                    </span>
                                  )}
                                </div>
                                <span className={`score-badge ${cIdx === 0 ? 'score-primary' : 'score-secondary'}`}>
                                  Score: {calculateScore(c).toFixed(0)} {cIdx === 0 ? "(Principal)" : ""}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {mode === "cleanup" && cleanupLeads.length > 0 && (
            <div style={{ marginTop: "20px", animation: "fadeIn 0.5s ease-out" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
                <h3 style={{ fontSize: "1rem", color: "#94a3b8", display: "flex", alignItems: "center", gap: "8px" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                  Amostra de Leads Inativos
                </h3>
                <button 
                  onClick={() => setShowSample(!showSample)}
                  style={{ background: "transparent", border: "1px solid var(--panel-border)", color: "var(--text-muted)", padding: "6px 12px", borderRadius: "8px", fontSize: "0.8rem", cursor: "pointer" }}
                >
                  {showSample ? "Ocultar Amostra" : "Ver Amostra de Inativos"}
                </button>
              </div>

              {showSample && (
                <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: "12px", padding: "15px", border: "1px solid var(--panel-border)" }}>
                  <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "15px" }}> 
                    Exibindo os primeiros 10 leads encontrados (Total: {cleanupLeads.length}).
                  </p>
                  
                  <div style={{ display: "grid", gap: "10px" }}>
                    {cleanupLeads.slice(0, 10).map((lead) => {
                      return (
                        <div key={lead.id} className="sample-card" style={{ padding: "10px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "8px" }}>
                          <div style={{ display: "flex", flexDirection: "column" }}>
                            <span style={{ fontSize: "0.9rem", color: "#fff", fontWeight: "500" }}>💼 {lead.name}</span>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "4px" }}>
                              Criado: {new Date(lead.created_at * 1000).toLocaleDateString('pt-BR')} | 
                              Última Atualização: {new Date(lead.updated_at * 1000).toLocaleDateString('pt-BR')}
                            </span>
                          </div>
                          <span style={{ fontSize: "0.8rem", color: "#fca5a5", background: "rgba(239, 68, 68, 0.1)", padding: "4px 8px", borderRadius: "6px" }}>
                            Inativo
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="log-container" style={{ height: "300px" }}>
            {logs.length === 0 ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", opacity: 0.5 }}>
                Os logs do processo de merge aparecerão aqui em tempo real...
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className={`log-entry ${log.type}`}>
                  <span style={{ opacity: 0.5, marginRight: "8px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    [{new Date().toLocaleTimeString('pt-BR')}]
                  </span>
                  {log.message}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>

      </div>
    </main>
  );
}
