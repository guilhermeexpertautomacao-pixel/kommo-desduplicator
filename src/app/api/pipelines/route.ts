import { NextResponse } from "next/server";

export const runtime = "edge";
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const subdomain = searchParams.get("subdomain");
  const token = searchParams.get("token");

  if (!subdomain || !token) {
    return NextResponse.json({ error: "Parâmetros ausentes" }, { status: 400 });
  }

  try {
    const res = await fetch(`https://${subdomain}.kommo.com/api/v4/leads/pipelines`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error(`Erro API Kommo: ${res.statusText}`);
    }

    const data = await res.json();
    const pipelines = data._embedded?.pipelines || [];

    return NextResponse.json({ pipelines });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
