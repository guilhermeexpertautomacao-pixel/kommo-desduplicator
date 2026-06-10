import { NextResponse } from "next/server";

export const runtime = "edge";
export async function POST(req: Request) {
  let subdomain = "";
  let token = "";
  let groups: any[][] = [];
  let entityType: "contacts" | "leads" = "contacts";

  try {
    const body = await req.json();
    subdomain = (body.subdomain || "").replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "").trim();
    token = (body.token || "").trim();
    groups = body.groups || [];
    entityType = body.entityType || "contacts";
  } catch (e) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendLog = (message: string, type: "info" | "success" | "warning" | "error" = "info", status: "running" | "completed" | "error" = "running") => {
        controller.enqueue(encoder.encode(JSON.stringify({ message, type, status }) + "\n"));
      };

      try {
        if (!groups || groups.length === 0) {
          sendLog("Nenhum grupo para processar neste lote.", "info", "completed");
          controller.close();
          return;
        }

        for (const entities of groups) {
          // O primeiro elemento do grupo é o Vencedor (já ordenado pelo frontend)
          const primary = entities[0];
          const secondaries = entities.slice(1);
          
          sendLog(`Processando grupo do ${entityType === 'contacts' ? 'Contato' : 'Lead'} Principal ID ${primary.id}...`, "info");
          
          // 1. Unificar tags e Campos Personalizados no Principal
          let newTags = [...(primary._embedded?.tags || [])];
          let primaryFields = [...(primary.custom_fields_values || [])];
          let hasChanges = false;
          let fieldsToUpdate: any[] = [];
          
          for (const sec of secondaries) {
            // 1a. Merge de Tags
            const secTags = sec._embedded?.tags || [];
            for (const t of secTags) {
              if (!newTags.find((pt) => pt.id === t.id)) {
                newTags.push({ id: t.id });
                hasChanges = true;
              }
            }

            // 1b. Merge de Campos Personalizados
            // Se o principal não tem um campo que o secundário tem, ou se o valor está vazio, herdamos.
            const secFields = sec.custom_fields_values || [];
            for (const sf of secFields) {
              const pf = primaryFields.find(f => f.field_id === sf.field_id);
              
              // Se o principal não tem o campo OU o campo existe mas está sem valores úteis
              const isPrimaryEmpty = !pf || !pf.values || pf.values.length === 0 || pf.values.every((v: any) => !v.value);
              const hasSecValue = sf.values && sf.values.length > 0 && sf.values.some((v: any) => v.value);

              if (isPrimaryEmpty && hasSecValue) {
                // Adiciona ou substitui no array de campos que vamos enviar
                const alreadyInUpdate = fieldsToUpdate.find(f => f.field_id === sf.field_id);
                if (!alreadyInUpdate) {
                  fieldsToUpdate.push({
                    field_id: sf.field_id,
                    values: sf.values
                  });
                  // Também atualizamos nossa referência local para o próximo loop não sobrescrever com outro secundário
                  primaryFields.push(sf);
                  hasChanges = true;
                }
              }
            }
          }

          if (hasChanges) {
            const updateBody: any = { id: primary.id };
            if (newTags.length > (primary._embedded?.tags?.length || 0)) {
              updateBody._embedded = { tags: newTags };
            }
            if (fieldsToUpdate.length > 0) {
              updateBody.custom_fields_values = fieldsToUpdate;
              sendLog(`Agregando ${fieldsToUpdate.length} campos personalizados ao Principal...`, "info");
            }

            await fetch(`https://${subdomain}.kommo.com/api/v4/${entityType}`, {
              method: 'PATCH',
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify([updateBody])
            });
          }

          // 2. Transferir vínculos e Marcar secundários
          for (const sec of secondaries) {
            if (entityType === "contacts") {
              const secLeads = sec._embedded?.leads || [];
              if (secLeads.length > 0) {
                sendLog(`Transferindo ${secLeads.length} leads do ID ${sec.id} para ${primary.id}`);
                for (const lead of secLeads) {
                  await fetch(`https://${subdomain}.kommo.com/api/v4/leads/${lead.id}/link`, {
                    method: 'POST',
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                    body: JSON.stringify([{ to_entity_id: primary.id, to_entity_type: "contacts" }])
                  });
                }
              }
            } else {
              // MODO LEADS: Transferir Contatos vinculados do secundário para o principal
              const secContacts = sec._embedded?.contacts || [];
              if (secContacts.length > 0) {
                sendLog(`Herdando ${secContacts.length} contatos do Negócio ${sec.id} para o Principal ${primary.id}`);
                for (const contact of secContacts) {
                  await fetch(`https://${subdomain}.kommo.com/api/v4/leads/${primary.id}/link`, {
                    method: 'POST',
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                    body: JSON.stringify([{ to_entity_id: contact.id, to_entity_type: "contacts" }])
                  });
                }
              }
            }
            
            // 2.5 Migrar Notas e Histórico
            try {
              sendLog(`Migrando notas do ID ${sec.id} para ${primary.id}...`);
              const notesRes = await fetch(`https://${subdomain}.kommo.com/api/v4/${entityType}/${sec.id}/notes`, {
                headers: { "Authorization": `Bearer ${token}` }
              });
              
              if (notesRes.status === 200) {
                const responseText = await notesRes.text();
                if (responseText && responseText.trim()) {
                  let notesData;
                  try {
                    notesData = JSON.parse(responseText);
                  } catch (e) {
                    notesData = null;
                  }

                  const notes = notesData?._embedded?.notes || [];
                  
                  if (notes.length > 0) {
                    const notesToCreate = notes.map((n: any) => {
                      const date = new Date(n.created_at * 1000).toLocaleString('pt-BR');
                      let text = `--- NOTA MIGRADA ---\n`;
                      text += `Data Original: ${date}\n`;
                      text += `Origem: ID ${sec.id}\n`;
                      text += `Tipo: ${n.note_type}\n`;
                      text += `-------------------\n\n`;
                      
                      if (n.params?.text) {
                        text += n.params.text;
                      } else if (n.params?.content) {
                        text += n.params.content;
                      } else if (n.params?.VALUE) {
                        text += n.params.VALUE;
                      } else if (typeof n.params === 'object') {
                        // Fallback para outros tipos de parâmetros (ex: chamadas, mensagens de chat estruturadas)
                        text += JSON.stringify(n.params, null, 2);
                      } else {
                        text += String(n.params || "");
                      }
                      
                      return {
                        note_type: "common",
                        params: { text }
                      };
                    });

                    // Criar as notas no principal em lote
                    await fetch(`https://${subdomain}.kommo.com/api/v4/${entityType}/${primary.id}/notes`, {
                      method: 'POST',
                      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                      body: JSON.stringify(notesToCreate)
                    });
                    sendLog(`${notes.length} notas migradas com sucesso.`, "success");
                  }
                }
              }
            } catch (noteErr: any) {
              sendLog(`Aviso: Falha ao migrar notas do ID ${sec.id}: ${noteErr.message}`, "warning");
            }
            
            // 3. Marcar secundário como Mesclado
            await fetch(`https://${subdomain}.kommo.com/api/v4/${entityType}`, {
              method: 'PATCH',
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify([{
                id: sec.id,
                _embedded: { tags: [{ name: "Desduplicado_Mesclado" }] }
              }])
            });
          }
          sendLog(`Grupo do ID ${primary.id} processado com sucesso.`, "success");
        }

        sendLog("Lote finalizado.", "success", "completed");
        controller.close();
      } catch (err: any) {
        sendLog(`Erro no processamento: ${err.message || String(err)}`, "error", "error");
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache"
    }
  });
}
