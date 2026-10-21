function cfg() {
  if (!window.SV_CONFIG?.SUPABASE_URL || !window.SV_CONFIG?.SUPABASE_ANON_KEY) {
    throw new Error("Copie config.example.js para config.js e preencha Supabase.");
  }
  return window.SV_CONFIG;
}

function sbHeaders(prefer) {
  const h = {
    apikey: cfg().SUPABASE_ANON_KEY,
    Authorization: `Bearer ${cfg().SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function sbGet(table, query = "") {
  const url = `${cfg().SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`GET ${table}: ${res.status}`);
  return res.json();
}

async function sbPost(table, body, prefer = "return=representation") {
  const url = `${cfg().SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: sbHeaders(prefer),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`POST ${table}: ${res.status} ${txt}`);
  }
  if (prefer.includes("minimal")) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbPatch(table, query, body) {
  const url = `${cfg().SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: sbHeaders("return=minimal"),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PATCH ${table}: ${res.status} ${txt}`);
  }
}

async function loadCatalogsOnline() {
  const [operacoes, eventos, insumos, locais, colaboradores, frotas] = await Promise.all([
    sbGet("dim_operacao_campo", "select=id,codigo,nome,exige_talhao,exige_insumo,deslocamento_modo&ativo=eq.true&order=ordem"),
    sbGet("dim_evento_campo", "select=codigo,nome,exige_horimetro,exige_hora,categoria&ativo=eq.true&order=ordem_ui"),
    sbGet("dim_insumos_campo", "select=id,codigo_sap,descricao,unidade&ativo=eq.true&order=descricao"),
    sbGet("dim_locais", "select=id,nome&ativo=eq.true&order=nome"),
    sbGet(
      "dim_colaborador",
      "select=nome&ativo=eq.true&funcao=in.(TRATORISTA,OPERADOR)&order=nome"
    ),
    sbGet("dim_frota", "select=id_frota,modelo&ativo=eq.true&order=id_frota").catch(() => []),
  ]);
  const catalog = { operacoes, eventos, insumos, locais, colaboradores, frotas };
  await Storage.saveCatalog("main", catalog);
  return catalog;
}

async function getCatalogs() {
  if (navigator.onLine) {
    try {
      return await loadCatalogsOnline();
    } catch (e) {
      console.warn(e);
    }
  }
  const cached = await Storage.getCatalog("main");
  if (cached) return cached;
  throw new Error("Sem catálogo offline. Conecte-se uma vez.");
}

async function findOpenTurn(data, frota, operador) {
  const q =
    `data=eq.${data}&id_frota=eq.${encodeURIComponent(frota)}` +
    `&operador=eq.${encodeURIComponent(operador)}&status=eq.ABERTO&select=*&limit=1`;
  const rows = await sbGet("campo_turno", q);
  return rows[0] || null;
}
