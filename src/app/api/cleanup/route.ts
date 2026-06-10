import { NextResponse } from "next/server";

export const runtime = "edge";
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const subdomain = (searchParams.get("subdomain") || "").replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "").trim();
  const token = searchParams.get("token");
  const createdBefore = searchParams.get("createdBefore");
  const updatedBefore = searchParams.get("updatedBefore");
  const page = searchParams.get("page") || "1";

  if (!subdomain || !token) {
    return NextResponse.json({ error: "Parâmetros ausentes" }, { status: 400 });
  }

  try {
    let url = `https://${subdomain}.kommo.com/api/v4/leads?limit=250&page=${page}&with=contacts,tags`;
    
    if (createdBefore) {
      url += `&filter[created_at][to]=${createdBefore}`;
    }
    if (updatedBefore) {
      url += `&filter[updated_at][to]=${updatedBefore}`;
    }

    const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });

    if (res.status === 204) return NextResponse.json({ leads: [], hasMore: false });
    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `Erro API Kommo: ${errText}` }, { status: res.status });
    }

    const data = await res.json();
    let leads = data?._embedded?.leads || [];

    // Verificação extra de segurança para last_incoming_message_at para garantir que mensagens recentes bloqueiem a limpeza
    if (updatedBefore) {
      const ubTimestamp = parseInt(updatedBefore, 10);
      leads = leads.filter((lead: any) => {
        if (lead.last_incoming_message_at && lead.last_incoming_message_at > ubTimestamp) {
          return false; // Ignorar leads que tiveram mensagens recentes
        }
        return true;
      });
    }

    return NextResponse.json({ leads, hasMore: (data?._embedded?.leads?.length === 250) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const subdomain = (body.subdomain || "").replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "").trim();
    const token = body.token;
    const leads = body.leads || [];
    const tagName = body.tagName || "Para_Exclusao";

    if (!subdomain || !token || !leads.length) {
      return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendLog = (message: string, type: string = "info") => {
          controller.enqueue(encoder.encode(JSON.stringify({ message, type }) + "\n"));
        };

        try {
          const batchSize = 50; // Atualizar de 50 em 50 para evitar sobrecarga na API
          for (let i = 0; i < leads.length; i += batchSize) {
            const batch = leads.slice(i, i + batchSize);
            sendLog(`Aplicando tag em lote ${Math.floor(i/batchSize) + 1} de ${Math.ceil(leads.length/batchSize)}...`, "info");
            
            const updatePayload = batch.map((lead: any) => {
              const currentTags = lead._embedded?.tags || [];
              const newTags = [...currentTags];
              if (!newTags.find((t: any) => t.name === tagName)) {
                newTags.push({ name: tagName });
              }
              return {
                id: lead.id,
                _embedded: { tags: newTags }
              };
            });

            const res = await fetch(`https://${subdomain}.kommo.com/api/v4/leads`, {
              method: 'PATCH',
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify(updatePayload)
            });

            if (!res.ok) {
               const errTxt = await res.text();
               sendLog(`Erro ao taguear lote: ${errTxt}`, "error");
            } else {
               sendLog(`Lote ${Math.floor(i/batchSize) + 1} tagueado com sucesso!`, "success");
            }
          }
          sendLog("Processo de tagueamento finalizado com sucesso!", "success");
          controller.close();
        } catch (err: any) {
          sendLog(`Erro crítico: ${err.message}`, "error");
          controller.close();
        }
      }
    });

    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
