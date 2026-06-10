import { NextResponse } from "next/server";

export const runtime = "edge";
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const subdomainRaw = searchParams.get("subdomain") || "";
  const subdomain = subdomainRaw.replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "").trim();
  const token = searchParams.get("token");
  const page = searchParams.get("page") || "1";

  const entity = searchParams.get("entity") || "contacts";
  const pipelineId = searchParams.get("pipeline_id");

  if (!subdomain || !token) {
    return NextResponse.json({ error: "Parâmetros ausentes" }, { status: 400 });
  }

  try {
    const ids = searchParams.get("ids");

    let url = entity === "leads" 
      ? `https://${subdomain}.kommo.com/api/v4/leads?with=contacts,tags,lossless_audio,talks&limit=250&page=${page}${pipelineId ? `&filter[pipeline_id]=${pipelineId}` : ''}`
      : `https://${subdomain}.kommo.com/api/v4/contacts?with=leads,tags,lossless_audio,talks&limit=250&page=${page}`;

    if (ids) {
      // Garantir que o separador ? ou & seja correto
      url += `&filter[id]=${ids}`;
    }

    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (res.status === 204) {
      return NextResponse.json({ 
        [entity]: [] 
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `Erro API Kommo: ${errText}` }, { status: res.status });
    }

    const data = await res.json();
    const items = data?._embedded?.[entity] || [];
    
    return NextResponse.json({ 
      [entity]: items,
      hasMore: items.length === 250
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
