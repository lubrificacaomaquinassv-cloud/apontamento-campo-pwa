/** Estado da jornada ativa (memória + IndexedDB) */
let catalog = null;
let turn = null; // { id, client_turn_id, seq, id_ciclo, ... }

const JOURNEY_BUTTONS = [
  { codigo: "PARADA_ALMOCO", label: "Parada almoço", hint: "Somente horário" },
  { codigo: "RETORNO_ALMOCO", label: "Retorno almoço", hint: "Horário do retorno" },
  { codigo: "PARADA_CLIMA", label: "Parada clima", hint: "Se não retornar → finalizar talhão" },
  {
    codigo: "PARADA_TECNICA",
    label: "Parada técnica",
    hint: "Aguardando liberação de área / frente",
  },
  { codigo: "PARADA_MECANICA", label: "Parada mecânica", hint: "Horário e HR se houver" },
  { codigo: "RETORNO_OPERACAO", label: "Retorno operação", hint: "Após parada" },
  { codigo: "FINALIZAR_TALHAO", label: "Finalizar talhão", hint: "Hora e horímetro deste talhão" },
  { codigo: "LANCAMENTO_INSUMOS", label: "Lançar insumos", hint: "Após finalizar o talhão", highlight: true },
  { codigo: "FIM_OPERACAO", label: "Fim operação", hint: "Acabou o serviço no campo" },
  { codigo: "DESLOC_FRENTE_SEDE", label: "Desloc. retorno sede", hint: "Depois do fim da operação" },
  { codigo: "FINAL_TURNO", label: "Fim turno", hint: "Depois do fim da operação" },
];

function turnoExigeDeslocRetorno() {
  return turn?.modo_deslocamento === "COM";
}

function etapaInsumosPendente() {
  return !!turn?.fase_pos_fim && operacaoExigeInsumo();
}

const OPS_SEM_TALHAO_COD = new Set([
  "CARRETA_DO_SAL",
  "CARRETA_SAL",
  "IRRIGACAO",
  "SERVICOS_DIVERSOS",
  "COLETA_RESIDUOS",
  "LIMPEZA_COCHO",
  "ENTERRO_ANIMAIS",
  "ACEIRO",
  "ENCABECANDO_CURVA",
  "MANUTENCAO_DE_ESTRADA",
  "TRATO",
]);

const OPS_SEM_TALHAO_NOME = new Set(
  [
    "CARRETA DO SAL",
    "IRRIGACAO",
    "SERVICOS DIVERSOS",
    "COLETA DE RESIDUOS",
    "LIMPEZA DE COCHO",
    "ENTERRO DE ANIMAIS",
    "ACEIRO",
    "ENCABEÇAMENTO DE CURVA",
    "ENCABECANDO CURVA",
    "MANUTENCAO DE ESTRADA",
    "MANUTENÇÃO DE ESTRADA",
    "TRATO",
  ].map(foldTxt)
);

function resolveExigeTalhao(op, nomeOperacao) {
  if (op?.codigo && OPS_SEM_TALHAO_COD.has(op.codigo)) return false;
  const nome = foldTxt(nomeOperacao || op?.nome);
  if (nome && OPS_SEM_TALHAO_NOME.has(nome)) return false;
  if (op?.exige_talhao != null) return !!op.exige_talhao;
  return true;
}

function operacaoSemTalhaoConhecida() {
  const op = catalog?.operacoes?.find((o) => o.id === turn?.id_operacao_campo);
  return !resolveExigeTalhao(op, turn?.operacao_nome);
}

function operacaoExigeTalhao() {
  const op = catalog?.operacoes?.find((o) => o.id === turn?.id_operacao_campo);
  return resolveExigeTalhao(op, turn?.operacao_nome);
}

/** Atualiza flag no turno salvo (turnos abertos antes do v27). */
function refreshTurnExigeTalhao() {
  if (!turn) return;
  turn.exige_talhao = operacaoExigeTalhao();
}

/** Só bloqueia fim operação / turno quando a operação usa fluxo de talhão. */
function cicloPendenteFinalizarTalhao() {
  return !!turn && operacaoExigeTalhao() && turn.ciclo_ativo !== false;
}

function talhaoProntoParaSeguir() {
  if (!turn) return false;
  if (!operacaoExigeTalhao()) {
    if (etapaInsumosPendente()) return false;
    return true;
  }
  if (turn.ciclo_ativo !== false) return false;
  if (etapaInsumosPendente()) return false;
  if (operacaoExigeInsumo() && !turn.insumos_talhao_concluido && !turn.insumo_lancado_talhao) {
    return false;
  }
  return true;
}

function podeEncerrarTurno() {
  if (!talhaoProntoParaSeguir()) return false;
  if (!turn.operacao_encerrada) return false;
  if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) return false;
  return true;
}

/** Após lançar insumo, libera próximo talhão / fim operação. */
async function concluirEtapaInsumosTalhao() {
  if (!turn?.fase_pos_fim && !turn?.insumo_lancado_talhao) return;
  turn.fase_pos_fim = false;
  turn.insumos_talhao_concluido = true;
  await Storage.saveActiveTurn(turn);
  refreshPosCicloUI();
  renderEventButtons();
}

function operacaoExigeInsumo() {
  if (turn?.exige_insumo != null) return !!turn.exige_insumo;
  const op = catalog?.operacoes?.find((o) => o.id === turn?.id_operacao_campo);
  return !!op?.exige_insumo;
}

function insumoCicloId() {
  return turn?.id_ciclo_fechado ?? turn?.id_ciclo;
}

async function concluirInsumosTalhao() {
  if (!turn?.fase_pos_fim) {
    if (turn?.insumos_talhao_concluido && turn.ciclo_ativo === false && !turn.operacao_encerrada) {
      startNextTalhao();
      return;
    }
    toast("Nada pendente neste talhão.");
    return;
  }
  turn.insumo_lancado_talhao = turn.insumo_lancado_talhao || false;
  await concluirEtapaInsumosTalhao();
  toast("Talhão concluído — use «Próximo talhão» ou «Fim operação».");
}

function $(id) {
  return document.getElementById(id);
}

const APP_VERSION = "v28";

function foldTxt(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function readFrota() {
  const hid = ($("frotaValor")?.value || "").trim();
  if (hid) return hid.toUpperCase();
  const raw = ($("frotaPick").value || "").trim();
  const m = raw.match(/^(\d+[A-Za-z0-9]*)/);
  if (m) return m[1].toUpperCase();
  return raw.toUpperCase();
}

function readOperador() {
  const hid = ($("operadorValor")?.value || "").trim();
  if (hid) return hid.toUpperCase();
  return ($("operadorPick").value || "").trim().toUpperCase();
}

function setComboSelecionado(valorId, hintId, valor, rotulo) {
  $(valorId).value = valor || "";
  const hint = $(hintId);
  if (!valor) {
    hint.classList.add("hidden");
    hint.textContent = "—";
    return;
  }
  hint.textContent = `Selecionado: ${rotulo || valor}`;
  hint.classList.remove("hidden");
}

function renderComboList(listEl, items, onPick) {
  listEl.innerHTML = "";
  if (!items.length) {
    listEl.classList.add("hidden");
    return;
  }
  for (const it of items.slice(0, 12)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "combo-item";
    btn.textContent = it.label;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onPick(it);
    });
    listEl.appendChild(btn);
  }
  listEl.classList.remove("hidden");
}

function wireCombo({ inputId, listId, valorId, hintId, getItems }) {
  const inp = $(inputId);
  const list = $(listId);
  const filtrar = () => {
    const q = foldTxt(inp.value);
    const all = getItems();
    if (!q) {
      renderComboList(list, all.slice(0, 12), pick);
      return;
    }
    const hits = all.filter((it) => foldTxt(it.label).includes(q) || foldTxt(it.value).includes(q));
    renderComboList(list, hits, pick);
  };
  const pick = (it) => {
    inp.value = it.value;
    setComboSelecionado(valorId, hintId, it.value, it.label);
    list.classList.add("hidden");
    inp.blur();
  };
  inp.addEventListener("focus", filtrar);
  inp.addEventListener("input", () => {
    setComboSelecionado(valorId, hintId, "", "");
    filtrar();
  });
  inp.addEventListener("blur", () => {
    setTimeout(() => list.classList.add("hidden"), 180);
    const typed = (inp.value || "").trim();
    if (!typed) {
      setComboSelecionado(valorId, hintId, "", "");
      return;
    }
    const all = getItems();
    const exact = all.find(
      (it) => foldTxt(it.value) === foldTxt(typed) || foldTxt(it.label) === foldTxt(typed)
    );
    if (exact) {
      inp.value = exact.value;
      setComboSelecionado(valorId, hintId, exact.value, exact.label);
      return;
    }
    const starts = all.filter(
      (it) => foldTxt(it.value).startsWith(foldTxt(typed)) || foldTxt(it.label).startsWith(foldTxt(typed))
    );
    if (starts.length === 1) {
      inp.value = starts[0].value;
      setComboSelecionado(valorId, hintId, starts[0].value, starts[0].label);
      return;
    }
    setComboSelecionado(valorId, hintId, typed, typed);
  });
}

function wirePickCombos() {
  wireCombo({
    inputId: "frotaPick",
    listId: "frotaList",
    valorId: "frotaValor",
    hintId: "frotaSelHint",
    getItems: () =>
      (catalog?.frotas || []).map((f) => ({
        value: String(f.id_frota),
        label: f.modelo ? `${f.id_frota} — ${f.modelo}` : String(f.id_frota),
      })),
  });
  wireCombo({
    inputId: "operadorPick",
    listId: "operadorList",
    valorId: "operadorValor",
    hintId: "operadorSelHint",
    getItems: () =>
      (catalog?.colaboradores || []).map((c) => ({
        value: String(c.nome),
        label: String(c.nome),
      })),
  });
}

function fillFrotaOperadorSelects() {
  /* lista montada na digitação (wirePickCombos) */
}

function isNetworkError(e) {
  const m = String(e?.message || e || "").toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("load failed") ||
    m.includes("err_internet") ||
    m.includes("err_connection") ||
    m.includes("aborterror")
  );
}

async function createOfflineTurn(payload, op, modo) {
  turn = {
    ...payload,
    seq: 1,
    pending: true,
    exige_insumo: op.exige_insumo,
    exige_talhao: resolveExigeTalhao(op, op.nome),
    desloc_retorno_concluido: false,
    desloc_retorno_registrado: false,
    ciclo_ativo: false,
    fase_pos_fim: false,
    operacao_encerrada: false,
    pendingEvents: [
      {
        client_event_id: crypto.randomUUID(),
        seq: 1,
        codigo_evento: "INICIO_TURNO",
        hora: payload.hora_inicio_turno,
        horimetro: payload.horimetro_inicio_turno,
        origem: "PWA",
      },
    ],
  };
  await Storage.saveActiveTurn(turn);
  toast("Sem servidor — lançamento no aparelho (sincronize quando tiver 4G/Wi‑Fi).", 7500);
  return true;
}

function dedupePendingEvents(events) {
  const list = [...(events || [])];
  for (const cod of ["FINAL_TURNO"]) {
    const matches = list.filter((e) => e.codigo_evento === cod);
    if (matches.length > 1) {
      const keep = matches[matches.length - 1];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].codigo_evento === cod) list.splice(i, 1);
      }
      list.push(keep);
    }
  }
  return list;
}

async function fecharTurnoNaUI(msg = "Turno encerrado") {
  if (turn) {
    const snap = { ...turn, pendingEvents: [...(turn.pendingEvents || [])] };
    if (await canSyncNow()) {
      try {
        await syncPendingTurn();
        await flushPendingEvents();
      } catch (e) {
        console.warn(e);
        if (snap.pendingEvents.length || snap.pending) await Storage.enqueueSync(snap);
      }
    } else if (snap.pendingEvents.length || snap.pending) {
      await Storage.enqueueSync(snap);
    }
  }
  await Storage.clearActiveTurn();
  turn = null;
  toast(msg);
  showScreen("screenHome");
  refreshHomeButtons();
}

async function processPendingSyncQueue() {
  if (!(await canSyncNow())) return;
  const keepTurn = (await Storage.getActiveTurn()) || turn;
  const rows = await Storage.listPendingSync();
  for (const row of rows) {
    turn = row.snap;
    try {
      await syncPendingTurn();
      await flushPendingEvents();
      if (turn?.id) await patchEncerramentoTurno(turn.hora_fim_turno, turn.horimetro_fim_turno);
      await Storage.dropPendingSync(row.client_turn_id);
    } catch (e) {
      console.warn("Fila sync", e);
    }
  }
  if (keepTurn?.id || keepTurn?.pending) {
    if (keepTurn.status !== "ENCERRADO") turn = keepTurn;
  } else if (!turn?.id && !turn?.pending) {
    turn = null;
  }
}

async function patchEncerramentoTurno(horaFim, hr) {
  const body = {
    status: "ENCERRADO",
    hora_fim_turno: horaFim,
    horimetro_fim_turno: hr,
    encerrado_em: new Date().toISOString(),
    estado_jornada: "TURNO_ENCERRADO",
    sync_status: "SINCRONIZADO",
  };
  if (await canSyncNow() && turn?.id) {
    await sbPatch("campo_turno", `id=eq.${turn.id}`, body);
  } else if (turn) {
    Object.assign(turn, body);
    turn.sync_status = "PENDENTE";
    await Storage.saveActiveTurn(turn);
  }
}

async function syncPendingTurn() {
  if (!(await canSyncNow()) || !turn) return false;
  if (!turn.pending && !(turn.pendingEvents?.length)) return false;
  const payload = {
    client_turn_id: turn.client_turn_id,
    data: turn.data,
    id_frota: turn.id_frota,
    operador: turn.operador,
    id_operacao_campo: turn.id_operacao_campo,
    operacao_nome: turn.operacao_nome,
    modo_deslocamento: turn.modo_deslocamento,
    status: turn.status || "ABERTO",
    estado_jornada: turn.estado_jornada || "TURNO_ABERTO",
    hora_inicio_turno: turn.hora_inicio_turno,
    horimetro_inicio_turno: turn.horimetro_inicio_turno,
    sync_status: "PENDENTE",
  };
  let existing = await findOpenTurn(payload.data, payload.id_frota, payload.operador);
  if (!existing) {
    const ins = await sbPost("campo_turno", payload);
    if (!ins?.[0]?.id) throw new Error("Turno não gravado");
    existing = ins[0];
  }
  let pending = dedupePendingEvents(turn.pendingEvents);
  turn = {
    ...existing,
    ...turn,
    id: existing.id,
    pending: false,
    pendingEvents: [],
  };
  turn.seq = await loadTurnMaxSeq();
  for (const row of pending) {
    if (row.codigo_evento === "FINAL_TURNO") {
      const dup = await sbGet(
        "fato_evento_campo",
        `id_turno=eq.${turn.id}&codigo_evento=eq.FINAL_TURNO&select=id&limit=1`
      );
      if (dup?.length) continue;
    }
    const ev = { ...row, id_turno: turn.id };
    if (!ev.seq || ev.seq <= (turn.seq || 0)) {
      ev.seq = (turn.seq || 0) + 1;
    }
    const insEv = await sbPost("fato_evento_campo", ev);
    const seq = insEv?.[0]?.seq;
    if (seq && seq > (turn.seq || 0)) turn.seq = seq;
  }
  const fin = pending.find((e) => e.codigo_evento === "FINAL_TURNO");
  if (fin) {
    await patchEncerramentoTurno(fin.hora, fin.horimetro);
  } else if (turn.estado_jornada === "OPERACAO_ATIVA") {
    await sbPatch("campo_turno", `id=eq.${turn.id}`, { estado_jornada: "OPERACAO_ATIVA" });
  }
  await Storage.saveActiveTurn(turn);
  return true;
}

/** Envia eventos locais de turno já gravado no servidor (ex.: fim offline com id). */
async function flushPendingEvents() {
  if (!turn?.id || !(await canSyncNow())) return false;
  const queue = dedupePendingEvents(turn.pendingEvents);
  if (!queue.length) return false;
  turn.seq = await loadTurnMaxSeq();
  for (const row of queue) {
    if (row.codigo_evento === "FINAL_TURNO") {
      const dup = await sbGet(
        "fato_evento_campo",
        `id_turno=eq.${turn.id}&codigo_evento=eq.FINAL_TURNO&select=id&limit=1`
      );
      if (dup?.length) continue;
    }
    const ev = { ...row, id_turno: turn.id };
    if (!ev.seq || ev.seq <= (turn.seq || 0)) ev.seq = (turn.seq || 0) + 1;
    const insEv = await sbPost("fato_evento_campo", ev);
    const seq = insEv?.[0]?.seq;
    if (seq && seq > (turn.seq || 0)) turn.seq = seq;
  }
  const fin = queue.find((e) => e.codigo_evento === "FINAL_TURNO");
  if (fin) await patchEncerramentoTurno(fin.hora, fin.horimetro);
  turn.pendingEvents = [];
  await Storage.saveActiveTurn(turn);
  return true;
}

function toast(msg, ms = 4500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), ms);
}

function advanceWizardFromStep1() {
  if (!turn) return;
  showScreen("screenWizard");
  const modo = turn.modo_deslocamento || $("modoDesloc").value;
  if (modo === "COM") {
    setWizardStep(2);
    $("horaSaida").value = nowTime();
    $("hrSaida").value = $("hrTurno").value;
    toast("Etapa 2 — deslocamento (saída)");
  } else {
    setWizardStep(4);
    $("hrOp").value = $("hrTurno").value;
    toast("Etapa 4 — início no talhão");
  }
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Última hora digitada no lançamento — não o relógio do celular. */
function horaPadrao() {
  const last = normHora(turn?.last_hora);
  return last || nowTime();
}

function lembrarHora(h) {
  const n = normHora(h);
  if (n && turn) turn.last_hora = n;
  return n;
}

/** Pergunta horário real do fato (lançamento no fim do dia). */
function promptHora(label, fallback) {
  const def = fallback || horaPadrao();
  const raw = prompt(`${label}\n(HH:MM):`, def);
  if (raw === null) return null;
  const h = raw.trim();
  if (!/^\d{1,2}:\d{2}$/.test(h)) {
    toast("Horário inválido — use HH:MM (ex.: 16:00)");
    return null;
  }
  const [hh, mm] = h.split(":").map((x) => parseInt(x, 10));
  if (hh > 23 || mm > 59) {
    toast("Horário inválido");
    return null;
  }
  const ok = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  lembrarHora(ok);
  return ok;
}

function horimetroBaseTurno() {
  const ini =
    turn?.horimetro_inicio_turno ?? parseFloat($("hrTurno")?.value);
  const last = turn?.last_hr;
  const vals = [ini, last].filter((x) => Number.isFinite(x) && x > 0);
  return vals.length ? Math.max(...vals) : null;
}

function normHora(t) {
  if (!t) return "";
  const s = String(t).trim();
  if (s.length >= 5) return s.slice(0, 5);
  return s;
}

const EVENTOS_SEM_DUPLICAR_HORA = new Set([
  "PARADA_ALMOCO",
  "RETORNO_ALMOCO",
  "PARADA_CLIMA",
  "PARADA_TECNICA",
  "PARADA_MECANICA",
  "RETORNO_OPERACAO",
  "PARADA_MUDANCA_TALHAO",
  "FINALIZAR_TALHAO",
  "FIM_OPERACAO",
]);

/** Catálogo offline desatualizado — ainda exige horário nestes códigos. */
const EVENTO_EXIGE_HORA_FALLBACK = new Set([
  "PARADA_ALMOCO",
  "RETORNO_ALMOCO",
  "PARADA_CLIMA",
  "PARADA_TECNICA",
  "PARADA_MECANICA",
  "RETORNO_OPERACAO",
]);

async function eventoJaLancado(codigo, hora) {
  const h = normHora(hora);
  if (!codigo || !h) return false;
  const same = (e) => e.codigo_evento === codigo && normHora(e.hora) === h;
  if ((turn?.pendingEvents || []).some(same)) return true;
  if (turn?.id && (await canSyncNow())) {
    try {
      const rows = await sbGet(
        "fato_evento_campo",
        `id_turno=eq.${turn.id}&codigo_evento=eq.${codigo}&select=hora`
      );
      if ((rows || []).some((r) => normHora(r.hora) === h)) return true;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  return false;
}

/** Recupera talhão / ciclo quando o operador retoma o turno pelo «Novo turno». */
async function hydrateTurnCiclo(t) {
  if (!t?.id || !(await canSyncNow())) return t;
  try {
    const ciclos = await sbGet(
      "campo_ciclo_operacao",
      `id_turno=eq.${t.id}&select=id,seq,status,talhao_codigo,retiro_id,hora_inicio,hora_fim,horimetro_ini,horimetro_fim&order=seq.desc`
    );
    const ativo = (ciclos || []).find((c) => c.status === "ATIVO");
    const last = ativo || (ciclos || [])[0];
    if (!last) return t;
    t.id_ciclo = last.id;
    t.talhao_codigo = last.talhao_codigo || t.talhao_codigo;
    t.retiro_id = last.retiro_id || t.retiro_id;
    t.ciclo_ativo = last.status === "ATIVO";
    if (last.status === "ATIVO") {
      t.fase_pos_fim = false;
      t.last_hr = last.horimetro_ini ?? t.last_hr;
      t.last_hora = normHora(last.hora_inicio) || t.last_hora;
    } else {
      t.last_hr = last.horimetro_fim ?? last.horimetro_ini ?? t.last_hr;
      t.last_hora = normHora(last.hora_fim) || normHora(last.hora_inicio) || t.last_hora;
    }
    const evs = await sbGet(
      "fato_evento_campo",
      `id_turno=eq.${t.id}&select=seq,codigo_evento&order=seq`
    );
    const lastFinalizar = [...(evs || [])].reverse().find((e) => e.codigo_evento === "FINALIZAR_TALHAO");
    const lastFimOp = [...(evs || [])].reverse().find((e) => e.codigo_evento === "FIM_OPERACAO");
    if (lastFinalizar && lastFimOp && lastFimOp.seq > lastFinalizar.seq) {
      t.operacao_encerrada = true;
    } else if (t.operacao_encerrada == null) {
      t.operacao_encerrada = false;
    }
  } catch (e) {
    console.warn("hydrate ciclo", e);
  }
  return t;
}

/** Avisa se horário de relógio igual ao início (permitido se o operador confirmar). */
function confirmarHoraRelogio(horaFim, referencias, label) {
  const hf = normHora(horaFim);
  for (const ref of referencias) {
    const r = normHora(ref);
    if (r && hf === r) {
      return window.confirm(
        `${label}: ${hf} é igual ao horário ${r} já lançado.\n` +
          "Confirma que é o relógio correto (e não confundiu com horímetro)?"
      );
    }
  }
  return true;
}

function validarHorimetro(hr, label) {
  if (!Number.isFinite(hr)) return false;
  const base = horimetroBaseTurno();
  if (base != null && base > 200 && hr < 200) {
    toast(
      `${label}: ${hr} parece HORA, não horímetro. Use o painel da máquina (perto de ${base}).`,
      8500
    );
    return false;
  }
  if (base != null && hr < base - 0.3) {
    toast(`${label}: horímetro deve ser ≥ ${base}`, 7000);
    return false;
  }
  return true;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function showScreen(name) {
  ["screenHome", "screenWizard", "screenJourney"].forEach((id) => {
    $(id).classList.toggle("hidden", id !== name);
  });
}

async function eventosDoTurno(t) {
  if (t?.id && (await canSyncNow())) {
    try {
      const rows = await sbGet(
        "fato_evento_campo",
        `id_turno=eq.${t.id}&select=seq,codigo_evento&order=seq`
      );
      if (rows?.length) return rows;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  return (t?.pendingEvents || []).map((e) => ({
    seq: e.seq,
    codigo_evento: e.codigo_evento,
  }));
}

function turnoTemInicioOperacao(evs) {
  return (evs || []).some((e) => e.codigo_evento === "INICIO_OPERACAO");
}

function preencherWizardComTurno(t) {
  if (t.data) $("dataOp").value = t.data;
  if (t.hora_inicio_turno) $("horaTurno").value = normHora(t.hora_inicio_turno);
  if (t.horimetro_inicio_turno != null) $("hrTurno").value = String(t.horimetro_inicio_turno);
  if (t.id_frota) {
    $("frotaValor").value = t.id_frota;
    $("frotaPick").value = t.id_frota;
  }
  if (t.operador) {
    $("operadorValor").value = t.operador;
    $("operadorPick").value = t.operador;
  }
  if (t.id_operacao_campo && catalog?.operacoes) {
    $("operacao").value = String(t.id_operacao_campo);
    onOperacaoChange();
  }
  const modo = t.modo_deslocamento;
  if (modo === "NAO_APLICA" || modo === "SEM" || modo === "NUNCA") $("modoDesloc").value = "SEM";
  else $("modoDesloc").value = "COM";
  if (t.talhao_codigo) $("talhaoCod").value = t.talhao_codigo;
  if (t.retiro_id) $("retiro").value = String(t.retiro_id);
}

async function resumeWizardParaTurno(t) {
  preencherWizardComTurno(t);
  showScreen("screenWizard");
  const modo = t.modo_deslocamento;
  const evs = await eventosDoTurno(t);
  const codigos = new Set((evs || []).map((e) => e.codigo_evento));
  const comDesloc = modo === "COM" || modo === "SEMPRE";
  if (comDesloc && !codigos.has("DESLOC_SEDE_FRENTE")) {
    setWizardStep(2);
    $("horaSaida").value = normHora(t.hora_inicio_turno) || nowTime();
    $("hrSaida").value = String(t.horimetro_inicio_turno ?? "");
    toast("Retomando — complete o deslocamento (etapa 2)");
    return;
  }
  if (!codigos.has("INICIO_OPERACAO")) {
    setWizardStep(4);
    $("hrOp").value = String(t.last_hr ?? t.horimetro_inicio_turno ?? "");
    $("horaOp").value = t.last_hora || horaPadrao();
    toast("Retomando — início da operação no campo");
    return;
  }
  showJourney();
}

async function resumirTurnoAberto() {
  const saved = await Storage.getActiveTurn();
  if (saved && (saved.id || saved.pending)) {
    turn = { ...saved, ...(turn?.id === saved.id ? turn : {}) };
  }
  if (!turn?.id && !turn?.pending) {
    toast("Nenhum turno salvo neste aparelho. Use «Novo turno».");
    refreshHomeButtons();
    return;
  }
  if (turn.status === "ENCERRADO") {
    await Storage.clearActiveTurn();
    turn = null;
    toast("Turno já encerrado — abra um novo.");
    refreshHomeButtons();
    return;
  }
  if (turn.id && (await canSyncNow())) {
    try {
      const row = await sbGet(
        "campo_turno",
        `id=eq.${turn.id}&select=id,status,estado_jornada&limit=1`
      );
      if (row?.[0]?.status === "ENCERRADO") {
        await Storage.clearActiveTurn();
        turn = null;
        toast("Turno encerrado no servidor.");
        refreshHomeButtons();
        return;
      }
      if (row?.[0]) {
        turn.status = row[0].status;
        turn.estado_jornada = row[0].estado_jornada || turn.estado_jornada;
      }
    } catch (e) {
      console.warn("status turno", e);
    }
  }
  refreshTurnExigeTalhao();
  await hydrateTurnCiclo(turn);
  const evs = await eventosDoTurno(turn);
  const jaOperando = turnoTemInicioOperacao(evs);
  if (jaOperando && turn.estado_jornada !== "OPERACAO_ATIVA") {
    turn.estado_jornada = "OPERACAO_ATIVA";
    if (turn.id && (await canSyncNow())) {
      try {
        await sbPatch("campo_turno", `id=eq.${turn.id}`, { estado_jornada: "OPERACAO_ATIVA" });
      } catch (e) {
        if (!isNetworkError(e)) console.warn("patch estado_jornada", e);
      }
    }
  }
  const emOperacao = turn.estado_jornada === "OPERACAO_ATIVA" || jaOperando;
  await Storage.saveActiveTurn(turn);
  if (emOperacao) {
    showJourney();
    toast("Turno retomado — continue a operação");
    return;
  }
  await resumeWizardParaTurno(turn);
}

function setWizardStep(n) {
  [1, 2, 3, 4].forEach((i) => {
    $(`step${i}`).classList.toggle("hidden", i !== n);
  });
  document.querySelectorAll("#wizardProgress span").forEach((el, i) => {
    el.classList.toggle("on", i < n);
  });
}

function updateNetStatus() {
  const on = navigator.onLine;
  $("netLabel").textContent = on ? "Rede: verificando…" : "Rede: offline";
  $("netLabel").className = on ? "ok" : "warn";
  $("offlineBanner").classList.toggle("hidden", on);
  refreshNetStatus();
}

async function refreshNetStatus() {
  const on = navigator.onLine;
  let label;
  let warn = true;
  if (!on) {
    label = "Rede: offline";
  } else if (await canSyncNow()) {
    label = "Rede: online";
    warn = false;
  } else {
    label = "Rede: sem servidor (modo local)";
  }
  $("netLabel").textContent = label;
  $("netLabel").className = warn ? "warn" : "ok";
  $("offlineBanner").classList.toggle("hidden", !warn);
}

function selectedOperacao() {
  const id = parseInt($("operacao").value, 10);
  return catalog.operacoes.find((o) => o.id === id);
}

function fillSelect(sel, items, valueKey, labelFn) {
  sel.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it[valueKey];
    opt.textContent = labelFn(it);
    sel.appendChild(opt);
  }
}

async function initCatalogs() {
  try {
    catalog = await getCatalogs();
  } catch (e) {
    const cached = await Storage.getCatalog("main");
    if (cached) {
      catalog = cached;
      console.warn("Catálogo do aparelho (offline):", e);
    } else {
      throw e;
    }
  }
  fillSelect($("operacao"), catalog.operacoes, "id", (o) => o.nome);
  fillSelect($("origemLoc"), catalog.locais, "id", (l) => l.nome);
  fillSelect($("destinoLoc"), catalog.locais, "id", (l) => l.nome);
  fillSelect($("retiro"), catalog.locais, "id", (l) => l.nome);
  fillFrotaOperadorSelects();
  onOperacaoChange();
}

async function nextSeq() {
  turn.seq = (turn.seq || 0) + 1;
  await Storage.saveActiveTurn(turn);
  return turn.seq;
}

async function pushEvent(row) {
  if (!(await canSyncNow())) {
    turn.pendingEvents = turn.pendingEvents || [];
    turn.pendingEvents.push(row);
    await Storage.saveActiveTurn(turn);
    return;
  }
  const inserted = await sbPost("fato_evento_campo", row);
  return inserted?.[0];
}

let _regLock = false;

async function registerEvent(codigo, extra = {}) {
  if (_regLock) return;
  _regLock = true;
  try {
    const evDef = catalog.eventos.find((e) => e.codigo === codigo);
    let hora = extra.hora;
    let horimetro = extra.horimetro;
    if ((evDef?.exige_hora || EVENTO_EXIGE_HORA_FALLBACK.has(codigo)) && !hora) {
      hora = promptHora(`Horário — ${evDef?.nome || codigo}`, horaPadrao());
      if (!hora) return;
    }
    if (hora) hora = normHora(hora);
    if (evDef?.exige_horimetro && horimetro == null) {
      const v = prompt("Horímetro:");
      if (v === null || v === "") return;
      horimetro = parseFloat(v);
    }
    if (EVENTOS_SEM_DUPLICAR_HORA.has(codigo) && hora && (await eventoJaLancado(codigo, hora))) {
      toast(`${evDef?.nome || codigo} já lançado neste horário — não duplica`);
      await refreshTimeline();
      return;
    }
    const seq = await nextSeq();
    const row = {
      client_event_id: crypto.randomUUID(),
      id_turno: turn.id,
      id_ciclo: extra.id_ciclo || turn.id_ciclo,
      seq,
      codigo_evento: codigo,
      hora: hora || null,
      horimetro: horimetro ?? null,
      talhao_codigo: extra.talhao_codigo || turn.talhao_codigo || null,
      retiro_id: extra.retiro_id || turn.retiro_id || null,
      observacao: extra.observacao || null,
      origem: "PWA",
    };
    await pushEvent(row);
    if (hora) lembrarHora(hora);
    turn.last_hr = horimetro ?? turn.last_hr;
    await Storage.saveActiveTurn(turn);
    await refreshTimeline();
    toast(`${evDef?.nome || codigo} registrado`);
  } finally {
    _regLock = false;
  }
}

async function refreshTimeline() {
  if (!turn?.id || !(await canSyncNow())) {
    $("timeline").innerHTML = turn?.pendingEvents?.length
      ? `<div>${turn.pendingEvents.length} evento(s) pendentes · sync ao conectar</div>`
      : "<div>—</div>";
    return;
  }
  const rows = await sbGet(
    "fato_evento_campo",
    `id_turno=eq.${turn.id}&select=seq,codigo_evento,hora,horimetro&order=seq`
  );
  $("timeline").innerHTML = rows
    .map((r) => `<div>${r.seq}. ${r.codigo_evento} ${r.hora || ""} ${r.horimetro ?? ""}</div>`)
    .join("");
}

function localNome(id) {
  if (!id) return "—";
  const l = catalog?.locais?.find((x) => x.id === id || x.id === Number(id));
  return l?.nome || `—`;
}

function closeModal() {
  $("modalOverlay").classList.add("hidden");
  $("modalProximoTalhao").classList.add("hidden");
  $("modalInsumos").classList.add("hidden");
  $("modalDeslocRetorno").classList.add("hidden");
}

function openModalDeslocRetorno() {
  fillSelect($("retOrigemLoc"), catalog.locais, "id", (l) => l.nome);
  fillSelect($("retDestinoLoc"), catalog.locais, "id", (l) => l.nome);
  if (turn.retiro_id) $("retOrigemLoc").value = String(turn.retiro_id);
  $("retHoraSaida").value = horaPadrao();
  $("retHrSaida").value = String(turn.last_hr ?? "");
  $("retHoraChegada").value = horaPadrao();
  $("retHrChegada").value = String(turn.last_hr ?? "");
  $("modalProximoTalhao").classList.add("hidden");
  $("modalInsumos").classList.add("hidden");
  $("modalDeslocRetorno").classList.remove("hidden");
  $("modalOverlay").classList.remove("hidden");
}

function openModalProximoTalhao() {
  fillSelect($("nextRetiro"), catalog.locais, "id", (l) => l.nome);
  if (turn.retiro_id) $("nextRetiro").value = String(turn.retiro_id);
  $("nextTalhaoCod").value = "";
  $("nextHoraOp").value = horaPadrao();
  const hrDefault = turn.last_hr ?? turn.horimetro_inicio_turno ?? "";
  $("nextHrOp").value = hrDefault !== "" ? String(hrDefault) : "";
  $("modalInsumos").classList.add("hidden");
  $("modalProximoTalhao").classList.remove("hidden");
  $("modalOverlay").classList.remove("hidden");
}

function openModalInsumos() {
  fillSelect($("insumoSelect"), catalog.insumos, "id", (i) => {
    const sap = i.codigo_sap ? `${i.codigo_sap} · ` : "";
    return `${sap}${i.descricao}`;
  });
  $("insumoQtd").value = "";
  updateInsumoUnidadeHint();
  $("modalProximoTalhao").classList.add("hidden");
  $("modalInsumos").classList.remove("hidden");
  $("modalOverlay").classList.remove("hidden");
}

function updateInsumoUnidadeHint() {
  const id = parseInt($("insumoSelect").value, 10);
  const ins = catalog.insumos.find((i) => i.id === id);
  $("insumoUnidadeHint").textContent = ins
    ? `Unidade: ${ins.unidade || "UN"}`
    : "Selecione o insumo";
}

function renderJourneyHead() {
  const retiro = localNome(turn.retiro_id);
  const ciclo = !operacaoExigeTalhao()
    ? "serviço em andamento (sem talhão)"
  : turn.ciclo_ativo === false
      ? "entre talhões (ciclo fechado)"
      : `Talhão ${turn.talhao_codigo || "—"}`;
  $("journeyHead").innerHTML = `
    <strong>${turn.id_frota} · ${turn.operador}</strong>
    <span>${turn.operacao_nome || ""} · HR ${turn.last_hr ?? turn.horimetro_inicio_turno ?? "—"}</span>
    <span>${ciclo} · Retiro ${retiro} · Sync ${turn.sync_status || "PENDENTE"}</span>`;
}

function refreshHomeButtons() {
  const aberto =
    turn &&
    turn.status !== "ENCERRADO" &&
    turn.status !== "CANCELADO" &&
    (turn.id || turn.pending);
  $("btnContinuar").classList.toggle("hidden", !aberto);
  $("hintContinuar").classList.toggle("hidden", !aberto);
  if (aberto && turn.ciclo_ativo === false) {
    $("btnContinuar").textContent = "Retomar operação (próximo talhão)";
  } else {
    $("btnContinuar").textContent = "Retomar operação";
  }
}

function refreshPosCicloUI() {
  const aberto =
    turn &&
    turn.status === "ABERTO" &&
    (turn.ciclo_ativo === false || !operacaoExigeTalhao());
  $("posCicloActions").classList.toggle("hidden", !aberto);
  if (!aberto) return;
  const tal = turn.talhao_codigo || "—";
  if (!operacaoExigeTalhao() && turn.ciclo_ativo !== false && !turn.operacao_encerrada) {
    $("posCicloHint").textContent = "Serviço sem talhão — use «Fim operação» (hora e horímetro).";
    $("btnInsumosPosFim").classList.add("hidden");
    $("btnSemInsumoTalhao").classList.add("hidden");
    $("btnProximoTalhao").classList.add("hidden");
    return;
  }
  if (turn.operacao_encerrada) {
    $("posCicloHint").textContent =
      "Serviço no campo encerrado — retorno à sede (se houver) e Fim turno.";
    $("btnInsumosPosFim").classList.add("hidden");
    $("btnSemInsumoTalhao").classList.add("hidden");
    $("btnProximoTalhao").classList.add("hidden");
    return;
  }
  if (turn.fase_pos_fim) {
    const exIn = operacaoExigeInsumo();
    $("posCicloHint").textContent = exIn
      ? `Talhão ${tal} finalizado — lance os insumos. Depois: Próximo talhão ou Fim operação.`
      : `Talhão ${tal} finalizado — «Próximo talhão» ou «Fim operação».`;
    $("btnInsumosPosFim").classList.toggle("hidden", !exIn);
    $("btnSemInsumoTalhao").classList.toggle("hidden", !exIn);
    $("btnSemInsumoTalhao").textContent = "Sem insumo neste talhão";
    $("btnProximoTalhao").classList.add("hidden");
  } else if (turn.insumos_talhao_concluido) {
    $("posCicloHint").textContent =
      `Talhão ${tal} ok — «Próximo talhão» (hora e HR) ou «Fim operação» se acabou o serviço.`;
    $("btnInsumosPosFim").classList.add("hidden");
    $("btnSemInsumoTalhao").classList.add("hidden");
    $("btnProximoTalhao").classList.remove("hidden");
  } else {
    $("posCicloHint").textContent = "Use «Finalizar talhão» (hora e horímetro).";
    $("btnInsumosPosFim").classList.add("hidden");
    $("btnSemInsumoTalhao").classList.add("hidden");
    $("btnProximoTalhao").classList.add("hidden");
  }
}

async function getNextCicloSeq() {
  if (!turn?.id) return (turn?.ciclo_seq_count || 0) + 1;
  const rows = await sbGet(
    "campo_ciclo_operacao",
    `id_turno=eq.${turn.id}&select=seq&order=seq.desc&limit=1`
  );
  return rows[0] ? rows[0].seq + 1 : 1;
}

async function startNextTalhaoFromForm() {
  if (!turn?.id) {
    toast("Turno não gravado no servidor — conecte-se e abra o turno de novo.");
    return;
  }
  if (!navigator.onLine) {
    toast("Próximo talhão exige internet nesta versão.");
    return;
  }
  const talhao = $("nextTalhaoCod").value.trim();
  const hora = $("nextHoraOp").value;
  const hr = parseFloat($("nextHrOp").value);
  const retiroId = parseInt($("nextRetiro").value, 10) || null;
  if (!talhao || !hora || !Number.isFinite(hr) || !retiroId) {
    toast("Preencha talhão, retiro, hora e horímetro");
    return;
  }
  closeModal();
  lembrarHora(hora);

  if (turn.id_ciclo && (await canSyncNow())) {
    try {
      await sbPatch(
        "campo_ciclo_operacao",
        `id_turno=eq.${turn.id}&status=eq.ATIVO`,
        {
          status: "FINALIZADO",
          hora_fim: turn.last_hora || hora,
          horimetro_fim: turn.last_hr ?? hr,
          fechado_em: new Date().toISOString(),
        }
      );
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }

  await registerEvent("PARADA_MUDANCA_TALHAO", {
    hora,
    talhao_codigo: String(talhao).trim(),
    retiro_id: retiroId,
  });

  const seq = await getNextCicloSeq();
  const ciclo = await sbPost("campo_ciclo_operacao", {
    id_turno: turn.id,
    seq,
    talhao_codigo: String(talhao).trim(),
    retiro_id: retiroId,
    status: "ATIVO",
    hora_inicio: hora,
    horimetro_ini: hr,
  });
  turn.id_ciclo = ciclo[0].id;
  turn.talhao_codigo = String(talhao).trim();
  turn.retiro_id = retiroId;
  turn.last_hr = hr;
  turn.ciclo_ativo = true;
  turn.fase_pos_fim = false;
  turn.insumos_talhao_concluido = false;
  turn.insumo_lancado_talhao = false;
  turn.operacao_encerrada = false;
  turn.id_ciclo_fechado = null;
  await registerEvent("INICIO_OPERACAO", {
    hora,
    horimetro: hr,
    retiro_id: retiroId,
    talhao_codigo: turn.talhao_codigo,
  });
  await sbPatch("campo_turno", `id=eq.${turn.id}`, { estado_jornada: "OPERACAO_ATIVA" });
  await Storage.saveActiveTurn(turn);
  renderJourneyHead();
  refreshPosCicloUI();
  refreshHomeButtons();
  renderEventButtons();
  toast(`Talhão ${turn.talhao_codigo} · ${localNome(retiroId)}`);
}

function startNextTalhao() {
  if (turn.operacao_encerrada) {
    toast("Fim operação já lançado — não abre outro talhão.");
    return;
  }
  if (turn.fase_pos_fim) {
    toast("Lance os insumos (ou «Sem insumo neste talhão») antes do próximo.");
    return;
  }
  if (operacaoExigeTalhao() && !turn.insumos_talhao_concluido && turn.ciclo_ativo === false) {
    toast("Finalize o talhão e os insumos antes do próximo.");
    return;
  }
  openModalProximoTalhao();
}

function renderEventButtons() {
  const wrap = $("eventButtons");
  wrap.innerHTML = "";
  const campoEncerrado = !!turn.operacao_encerrada;
  const precisaDesloc =
    turnoExigeDeslocRetorno() && campoEncerrado && !turn.desloc_retorno_concluido;
  const deslocOpcional =
    !turnoExigeDeslocRetorno() && campoEncerrado && !turn.desloc_retorno_registrado;
  for (const b of JOURNEY_BUTTONS) {
    if (b.codigo === "LANCAMENTO_INSUMOS" && !operacaoExigeInsumo()) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    let cls = "btn-event" + (b.highlight ? " highlight" : "");
    if (b.codigo === "DESLOC_FRENTE_SEDE" && (precisaDesloc || deslocOpcional)) cls += " highlight";
    if (b.codigo === "FIM_OPERACAO" && talhaoProntoParaSeguir() && !campoEncerrado) cls += " highlight";
    btn.className = cls;
    let hint = b.hint;
    if (b.codigo === "DESLOC_FRENTE_SEDE" && !turnoExigeDeslocRetorno()) {
      hint = "Opcional — voltou da frente à tarde";
    }
    btn.innerHTML = `${b.label}<small>${hint}</small>`;
    if (b.codigo === "FINALIZAR_TALHAO") {
      if (!operacaoExigeTalhao()) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Operação sem talhão — use «Fim operação»</small>`;
      } else if (turn.ciclo_ativo === false || campoEncerrado) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>${campoEncerrado ? "Serviço já encerrado" : "Talhão já finalizado"}</small>`;
      }
    }
    if (b.codigo === "LANCAMENTO_INSUMOS") {
      if (campoEncerrado) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Serviço já encerrado</small>`;
      } else if (turn.ciclo_ativo !== false && !turn.fase_pos_fim) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Após «Finalizar talhão»</small>`;
      }
    }
    if (b.codigo === "FIM_OPERACAO") {
      if (campoEncerrado) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Já lançado</small>`;
      } else if (cicloPendenteFinalizarTalhao()) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Finalize o talhão e os insumos primeiro</small>`;
      } else if (etapaInsumosPendente()) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Lance os insumos do talhão primeiro</small>`;
      }
    }
    if (b.codigo === "DESLOC_FRENTE_SEDE") {
      if (cicloPendenteFinalizarTalhao() || etapaInsumosPendente()) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Finalize o talhão / insumos primeiro</small>`;
      } else if (!campoEncerrado) {
        btn.disabled = true;
        btn.innerHTML = `${b.label}<small>Use «Fim operação» antes do retorno</small>`;
      } else if (turn.desloc_retorno_registrado) {
        btn.disabled = true;
      }
    }
    if (b.codigo === "FINAL_TURNO" && !podeEncerrarTurno()) {
      btn.disabled = true;
      if (cicloPendenteFinalizarTalhao()) {
        btn.innerHTML = `${b.label}<small>Finalize o talhão primeiro</small>`;
      } else if (etapaInsumosPendente()) {
        btn.innerHTML = `${b.label}<small>Lance os insumos do talhão</small>`;
      } else if (!campoEncerrado) {
        btn.innerHTML = `${b.label}<small>Use «Fim operação» para encerrar o serviço</small>`;
      } else if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) {
        btn.innerHTML = `${b.label}<small>Retorno sede ou toque 2x p/ fim no campo</small>`;
        btn.disabled = false;
        btn.className = cls.replace(" highlight", "");
      }
    }
    btn.addEventListener("click", () => onEventClick(b.codigo));
    wrap.appendChild(btn);
  }
}

async function fecharCicloAtual(horaFim, hr) {
  if (await canSyncNow()) {
    try {
      const q = turn.id_ciclo
        ? `id=eq.${turn.id_ciclo}`
        : `id_turno=eq.${turn.id}&status=eq.ATIVO`;
      await sbPatch("campo_ciclo_operacao", q, {
        status: "FINALIZADO",
        hora_fim: horaFim,
        horimetro_fim: hr,
        fechado_em: new Date().toISOString(),
      });
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  turn.ciclo_ativo = false;
  turn.insumo_lancado_talhao = false;
  turn.id_ciclo_fechado = turn.id_ciclo;
  turn.last_hr = hr;
  lembrarHora(horaFim);
}

async function aposFecharTalhao() {
  if (operacaoExigeInsumo()) {
    turn.fase_pos_fim = true;
    turn.insumos_talhao_concluido = false;
    await Storage.saveActiveTurn(turn);
    refreshPosCicloUI();
    refreshHomeButtons();
    renderEventButtons();
    toast(`Talhão ${turn.talhao_codigo || "—"}: lance os insumos`);
  } else {
    turn.fase_pos_fim = false;
    turn.insumos_talhao_concluido = true;
    await Storage.saveActiveTurn(turn);
    refreshPosCicloUI();
    refreshHomeButtons();
    renderEventButtons();
    toast("Talhão finalizado — «Próximo talhão» ou «Fim operação»");
  }
}

async function onEventClick(codigo) {
  if (codigo === "LANCAMENTO_INSUMOS") {
    if (turn.ciclo_ativo !== false && !turn.fase_pos_fim) {
      toast("Ordem: 1 Finalizar talhão → 2 Insumos → 3 Próximo talhão");
      return;
    }
    if (!catalog.insumos?.length) {
      toast("Catálogo de insumos vazio — sincronize online");
      return;
    }
    openModalInsumos();
    return;
  }
  if (codigo === "FINALIZAR_TALHAO") {
    if (turn.ciclo_ativo === false) {
      toast("Talhão já finalizado — lance insumos, «Próximo talhão» ou «Fim operação».");
      return;
    }
    const horaFim = promptHora("Horário fim deste talhão", horaPadrao());
    if (!horaFim) return;
    if (
      !confirmarHoraRelogio(horaFim, [turn.hora_inicio_turno, $("horaTurno")?.value], "Finalizar talhão")
    ) {
      return;
    }
    const hr = parseFloat(
      prompt("Horímetro fim deste talhão:", String(turn.last_hr ?? ""))
    );
    if (!Number.isFinite(hr)) return;
    if (!validarHorimetro(hr, "Finalizar talhão")) return;
    await registerEvent("FINALIZAR_TALHAO", { hora: horaFim, horimetro: hr });
    await fecharCicloAtual(horaFim, hr);
    await aposFecharTalhao();
    return;
  }
  if (codigo === "FIM_OPERACAO") {
    if (turn.operacao_encerrada) {
      toast("Fim operação já lançado — use retorno à sede ou Fim turno.");
      return;
    }
    if (cicloPendenteFinalizarTalhao()) {
      toast("Use «Finalizar talhão» (hora e HR) antes do fim da operação.");
      return;
    }
    if (etapaInsumosPendente()) {
      toast("Lance os insumos do talhão (ou «Sem insumo neste talhão») antes do fim da operação.");
      return;
    }
    const horaFim = promptHora("Horário fim da operação no campo", horaPadrao());
    if (!horaFim) return;
    const hr = parseFloat(
      prompt("Horímetro fim da operação:", String(turn.last_hr ?? ""))
    );
    if (!Number.isFinite(hr)) return;
    if (!validarHorimetro(hr, "Fim operação")) return;
    if (!operacaoExigeTalhao() && turn.ciclo_ativo !== false) {
      await fecharCicloAtual(horaFim, hr);
    }
    await registerEvent("FIM_OPERACAO", { hora: horaFim, horimetro: hr });
    turn.operacao_encerrada = true;
    turn.fase_pos_fim = false;
    turn.insumos_talhao_concluido = true;
    await Storage.saveActiveTurn(turn);
    refreshPosCicloUI();
    refreshHomeButtons();
    renderEventButtons();
    toast("Serviço no campo encerrado. Retorno à sede (se houver) e Fim turno.");
    return;
  }
  if (codigo === "DESLOC_FRENTE_SEDE") {
    if (cicloPendenteFinalizarTalhao()) {
      toast("Finalize o talhão antes do retorno à sede.");
      return;
    }
    if (etapaInsumosPendente()) {
      toast("Lance os insumos do talhão antes do retorno à sede.");
      return;
    }
    if (!turn.operacao_encerrada) {
      toast("Use «Fim operação» antes do retorno à sede.");
      return;
    }
    if (turn.desloc_retorno_registrado) {
      toast("Retorno à sede já registrado — use Fim turno.");
      return;
    }
    openModalDeslocRetorno();
    return;
  }
  if (codigo === "FINAL_TURNO") {
    if (turn._fechandoTurno) return;
    if ((turn.pendingEvents || []).some((e) => e.codigo_evento === "FINAL_TURNO")) {
      await fecharTurnoNaUI("Fim turno já registrado — volte ao início");
      return;
    }
    if (cicloPendenteFinalizarTalhao()) {
      toast("Use «Finalizar talhão» antes de encerrar o turno.");
      return;
    }
    if (etapaInsumosPendente()) {
      toast("Lance os insumos do talhão antes do fim do turno.");
      return;
    }
    if (!turn.operacao_encerrada) {
      toast("Use «Fim operação» para encerrar o serviço no campo, depois Fim turno.");
      return;
    }
    if (operacaoExigeInsumo() && !turn.insumos_talhao_concluido && turn.insumo_lancado_talhao) {
      await concluirEtapaInsumosTalhao();
    }
    if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) {
      if (!turn._fimTurnoSemRetornoPending) {
        turn._fimTurnoSemRetornoPending = true;
        toast("Sem retorno à sede? Toque «Fim turno» de novo para encerrar no campo.", 6500);
        await Storage.saveActiveTurn(turn);
        return;
      }
      turn.desloc_retorno_concluido = true;
      turn._fimTurnoSemRetornoPending = false;
      await Storage.saveActiveTurn(turn);
    }
    if (await canSyncNow() && turn.id) {
      const dup = await sbGet(
        "fato_evento_campo",
        `id_turno=eq.${turn.id}&codigo_evento=eq.FINAL_TURNO&select=id&limit=1`
      );
      if (dup?.length) {
        await fecharTurnoNaUI("Turno já encerrado no servidor");
        return;
      }
    }
    const horaFim = promptHora("Horário fim turno (na sede)", horaPadrao());
    if (!horaFim) return;
    const hr = parseFloat(
      prompt("Horímetro fim turno (na sede):", String(turn.last_hr ?? ""))
    );
    if (!Number.isFinite(hr)) return;
    if (!validarHorimetro(hr, "Fim turno")) return;
    turn._fechandoTurno = true;
    try {
      await registerEvent("FINAL_TURNO", { hora: horaFim, horimetro: hr });
      turn.ciclo_ativo = false;
      turn.fase_pos_fim = false;
      turn.insumos_talhao_concluido = true;
      try {
        await patchEncerramentoTurno(horaFim, hr);
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
      await fecharTurnoNaUI();
    } finally {
      if (turn) {
        turn._fechandoTurno = false;
        await Storage.saveActiveTurn(turn);
      }
    }
    return;
  }
  await registerEvent(codigo, {});
}

async function confirmDeslocRetorno() {
  const hrSaida = parseFloat($("retHrSaida").value);
  const hrChegada = parseFloat($("retHrChegada").value);
  const origemId = parseInt($("retOrigemLoc").value, 10) || null;
  const destinoId = parseInt($("retDestinoLoc").value, 10) || null;
  if (
    !origemId ||
    !destinoId ||
    !$("retHoraSaida").value ||
    !$("retHoraChegada").value ||
    !Number.isFinite(hrSaida) ||
    !Number.isFinite(hrChegada)
  ) {
    toast("Preencha origem, destino, horários e horímetros");
    return;
  }
  closeModal();
  if (navigator.onLine && turn.id) {
    await sbPost("fato_deslocamentos", {
      client_desloc_id: crypto.randomUUID(),
      id_turno: turn.id,
      tipo: "FRENTE_SEDE",
      origem_local_id: origemId,
      destino_local_id: destinoId,
      data: turn.data || todayISO(),
      hora_saida: $("retHoraSaida").value,
      hora_chegada: $("retHoraChegada").value,
      horimetro_saida: hrSaida,
      horimetro_chegada: hrChegada,
    });
  }
  await registerEvent("DESLOC_FRENTE_SEDE", {
    hora: $("retHoraSaida").value,
    horimetro: hrSaida,
  });
  turn.desloc_retorno_concluido = true;
  turn.desloc_retorno_registrado = true;
  turn.last_hr = hrChegada;
  await Storage.saveActiveTurn(turn);
  renderJourneyHead();
  renderEventButtons();
  toast("Chegada na sede registrada — agora use «Fim turno»");
}

async function loadTurnMaxSeq() {
  if (!turn?.id || !navigator.onLine) return turn?.seq || 0;
  const rows = await sbGet(
    "fato_evento_campo",
    `id_turno=eq.${turn.id}&select=seq&order=seq.desc&limit=1`
  );
  return rows[0]?.seq || 0;
}

async function startWizardFlow() {
  const op = selectedOperacao();
  if (!op) {
    toast("Selecione a operação");
    return false;
  }
  const hrTurno = parseFloat($("hrTurno").value);
  const frotaVal = readFrota();
  const operadorVal = readOperador();
  if (!frotaVal || !operadorVal) {
    toast("Selecione (ou digite) frota e operador");
    return false;
  }
  if (!Number.isFinite(hrTurno)) {
    toast("Horímetro início inválido");
    return false;
  }
  const modo =
    op.deslocamento_modo === "NUNCA" ? "NAO_APLICA" : op.deslocamento_modo === "SEMPRE" ? "COM" : $("modoDesloc").value;
  const payload = {
    client_turn_id: crypto.randomUUID(),
    data: $("dataOp").value,
    id_frota: frotaVal,
    operador: operadorVal,
    id_operacao_campo: op.id,
    operacao_nome: op.nome,
    modo_deslocamento: modo,
    status: "ABERTO",
    estado_jornada: "TURNO_ABERTO",
    hora_inicio_turno: $("horaTurno").value,
    horimetro_inicio_turno: hrTurno,
    sync_status: "PENDENTE",
  };
  if (!(await canSyncNow())) {
    return createOfflineTurn(payload, op, modo);
  }
  let resumed = false;
  try {
    let existing = await findOpenTurn(payload.data, payload.id_frota, payload.operador);
    if (existing) {
      const saved = await Storage.getActiveTurn();
      turn = {
        ...existing,
        ...(saved?.id === existing.id ? saved : {}),
        id: existing.id,
        status: existing.status,
        estado_jornada: existing.estado_jornada,
        modo_deslocamento: modo,
        exige_insumo: op.exige_insumo,
        exige_talhao: resolveExigeTalhao(op, op.nome),
        operacao_nome: op.nome,
        id_operacao_campo: op.id,
        desloc_retorno_concluido: existing.desloc_retorno_concluido ?? saved?.desloc_retorno_concluido ?? false,
        desloc_retorno_registrado: existing.desloc_retorno_registrado ?? saved?.desloc_retorno_registrado ?? false,
      };
      turn.seq = await loadTurnMaxSeq();
      await hydrateTurnCiclo(turn);
      resumed = true;
      toast("Continuando turno aberto de hoje");
      if (existing.estado_jornada === "OPERACAO_ATIVA") {
        await Storage.saveActiveTurn(turn);
        showJourney();
        return true;
      }
    } else {
      try {
        const ins = await sbPost("campo_turno", payload);
        if (!ins?.[0]?.id) throw new Error("Turno não gravado");
        turn = {
          ...ins[0],
          seq: 0,
          exige_insumo: op.exige_insumo,
          exige_talhao: resolveExigeTalhao(op, op.nome),
          desloc_retorno_concluido: false,
          desloc_retorno_registrado: false,
          ciclo_ativo: false,
          fase_pos_fim: false,
          operacao_encerrada: false,
        };
      } catch (postErr) {
        const msg = String(postErr.message || postErr);
        if (msg.includes("23505") || msg.toLowerCase().includes("duplicate")) {
          existing = await findOpenTurn(payload.data, payload.id_frota, payload.operador);
          if (!existing) {
            const q =
              `data=eq.${payload.data}&id_frota=eq.${encodeURIComponent(payload.id_frota)}` +
              `&operador=eq.${encodeURIComponent(payload.operador)}&select=id,status&limit=1`;
            const closed = await sbGet("campo_turno", q);
            if (closed[0]?.status === "ENCERRADO") {
              throw new Error(
                "Turno de hoje já encerrado (mesma frota/operador). Confira a data ou fale com o gestor."
              );
            }
            throw postErr;
          }
          const savedDup = await Storage.getActiveTurn();
          turn = {
            ...existing,
            ...(savedDup?.id === existing.id ? savedDup : {}),
            id: existing.id,
            modo_deslocamento: modo,
            exige_insumo: op.exige_insumo,
            exige_talhao: resolveExigeTalhao(op, op.nome),
          };
          turn.seq = await loadTurnMaxSeq();
          await hydrateTurnCiclo(turn);
          resumed = true;
          toast("Turno já existia — continuando");
        } else {
          throw postErr;
        }
      }
    }
    if (turn.desloc_retorno_registrado === undefined) turn.desloc_retorno_registrado = false;

    if (!resumed) {
      await nextSeq();
      await pushEvent({
        client_event_id: crypto.randomUUID(),
        id_turno: turn.id,
        seq: turn.seq,
        codigo_evento: "INICIO_TURNO",
        hora: $("horaTurno").value,
        horimetro: hrTurno,
        origem: "PWA",
      });
    }
    await Storage.saveActiveTurn(turn);
    return true;
  } catch (e) {
    console.error(e);
    if (isNetworkError(e)) {
      return createOfflineTurn(payload, op, modo);
    }
    let msg = e.message || "Erro ao abrir turno — tente de novo";
    if (msg.includes("PGRST204") || msg.includes("Could not find")) {
      msg = "Erro de versão do app — atualize a página (Catálogo OK · v28).";
    } else if (msg.length > 140) {
      msg = msg.slice(0, 140);
    }
    toast(msg, 7000);
    turn = null;
    return false;
  }
}

async function finishDeslocAndCiclo() {
  let idDesloc = null;
  const online = await canSyncNow();
  if (turn.modo_deslocamento === "COM" && online) {
    const desloc = await sbPost("fato_deslocamentos", {
      client_desloc_id: crypto.randomUUID(),
      id_turno: turn.id,
      tipo: "SEDE_FRENTE",
      origem_local_id: parseInt($("origemLoc").value, 10) || null,
      destino_local_id: parseInt($("destinoLoc").value, 10) || null,
      data: $("dataOp").value,
      hora_saida: $("horaSaida").value || null,
      hora_chegada: $("horaChegada").value || null,
      horimetro_saida: parseFloat($("hrSaida").value) || null,
      horimetro_chegada: parseFloat($("hrChegada").value) || null,
    });
    idDesloc = desloc[0].id;
    await registerEvent("DESLOC_SEDE_FRENTE", {
      hora: $("horaSaida").value,
      horimetro: parseFloat($("hrSaida").value),
    });
  } else if (turn.modo_deslocamento === "COM") {
    await registerEvent("DESLOC_SEDE_FRENTE", {
      hora: $("horaSaida").value,
      horimetro: parseFloat($("hrSaida").value),
    });
  }
  const retiroId = parseInt($("retiro").value, 10);
  turn.talhao_codigo = $("talhaoCod").value.trim() || null;
  turn.retiro_id = retiroId;
  turn.last_hr = parseFloat($("hrOp").value);

  if (online && turn.id) {
    const ciclo = await sbPost("campo_ciclo_operacao", {
      id_turno: turn.id,
      seq: 1,
      talhao_codigo: turn.talhao_codigo,
      retiro_id: retiroId,
      status: "ATIVO",
      hora_inicio: $("horaOp").value,
      horimetro_ini: turn.last_hr,
    });
    turn.id_ciclo = ciclo[0].id;
    turn.ciclo_ativo = true;
    turn.fase_pos_fim = false;
    turn.insumos_talhao_concluido = false;
    turn.insumo_lancado_talhao = false;
    turn.operacao_encerrada = false;
    await registerEvent("INICIO_OPERACAO", {
      hora: $("horaOp").value,
      horimetro: turn.last_hr,
      retiro_id: retiroId,
      talhao_codigo: turn.talhao_codigo,
    });
    await sbPatch("campo_turno", `id=eq.${turn.id}`, { estado_jornada: "OPERACAO_ATIVA" });
  } else {
    turn.ciclo_seq = 1;
    turn.ciclo_ativo = true;
    turn.fase_pos_fim = false;
    turn.insumos_talhao_concluido = false;
    turn.insumo_lancado_talhao = false;
    turn.operacao_encerrada = false;
    turn.estado_jornada = "OPERACAO_ATIVA";
    if (!turn.seq) turn.seq = 0;
    await registerEvent("INICIO_OPERACAO", {
      hora: $("horaOp").value,
      horimetro: turn.last_hr,
      retiro_id: retiroId,
      talhao_codigo: turn.talhao_codigo,
    });
  }
  await Storage.saveActiveTurn(turn);
  showJourney();
}

function showJourney() {
  refreshTurnExigeTalhao();
  renderJourneyHead();
  renderEventButtons();
  refreshTimeline();
  refreshPosCicloUI();
  refreshHomeButtons();
  showScreen("screenJourney");
}

function onOperacaoChange() {
  const op = selectedOperacao();
  const wrap = $("wrapDeslocEscolha");
  const fixo = $("wrapDeslocFixo");
  if (!op) {
    wrap.classList.add("hidden");
    fixo.classList.add("hidden");
    return;
  }
  const modo = op.deslocamento_modo || "OPCIONAL";
  if (modo === "OPCIONAL") {
    wrap.classList.remove("hidden");
    fixo.classList.add("hidden");
  } else {
    wrap.classList.add("hidden");
    fixo.classList.remove("hidden");
    if (modo === "NUNCA") {
      $("deslocFixoHint").textContent =
        "Não — operação na sede/pátio ou retiro (sem etapas de deslocamento no wizard).";
    } else if (modo === "SEMPRE") {
      $("deslocFixoHint").textContent =
        "Sim — deslocamento obrigatório (você passará pelas etapas 2 e 3: saída e chegada).";
    } else {
      $("deslocFixoHint").textContent = `Modo cadastro: ${modo}`;
    }
  }
}

async function boot() {
  updateNetStatus();
  window.addEventListener("online", () => {
    updateNetStatus();
    syncPendingTurn().catch(console.warn);
  });
  window.addEventListener("offline", updateNetStatus);

  $("dataOp").value = todayISO();
  $("horaTurno").value = nowTime();
  $("horaOp").value = nowTime();

  try {
    await initCatalogs();
    $("syncLabel").textContent = `Catálogo: OK · ${APP_VERSION}`;
    $("syncLabel").className = "ok";
  } catch (e) {
    $("syncLabel").textContent = `Sem catálogo · ${APP_VERSION}`;
    $("syncLabel").className = "warn";
    toast(
      "Este celular nunca baixou o catálogo. Com sinal: abra o app e aguarde «Catálogo: OK» antes de ir ao pátio.",
      9000
    );
  }
  showScreen("screenHome");

  const saved = await Storage.getActiveTurn();
  if (saved?.id || saved?.pending) {
    turn = saved;
    if (turn.ciclo_ativo === undefined && turn.id_ciclo) turn.ciclo_ativo = true;
    if (turn.ciclo_ativo === undefined && !turn.id_ciclo) turn.ciclo_ativo = false;
    if (turn.desloc_retorno_concluido === undefined) turn.desloc_retorno_concluido = false;
    if (turn.desloc_retorno_registrado === undefined) turn.desloc_retorno_registrado = false;
    refreshTurnExigeTalhao();
    await hydrateTurnCiclo(turn);
    await Storage.saveActiveTurn(turn);
  }
  refreshHomeButtons();
  try {
    await processPendingSyncQueue();
    if (turn?.pending) {
      await syncPendingTurn();
      toast("Turno sincronizado");
    }
  } catch (e) {
    console.warn(e);
  }
  refreshHomeButtons();

  wirePickCombos();
  $("operacao").addEventListener("change", onOperacaoChange);
  onOperacaoChange();

  $("btnNovoTurno").addEventListener("click", async () => {
    const saved = await Storage.getActiveTurn();
    const aberto = saved && (saved.id || saved.pending) && saved.status !== "ENCERRADO";
    if (aberto) {
      const seguir = window.confirm(
        "Já existe um turno aberto neste aparelho.\n\nOK = continuar o turno\nCancelar = iniciar outro (só se o turno anterior estiver encerrado)"
      );
      if (seguir) {
        turn = saved;
        await resumirTurnoAberto();
        return;
      }
    }
    setWizardStep(1);
    showScreen("screenWizard");
  });

  $("btnContinuar").addEventListener("click", () => resumirTurnoAberto());

  $("btnProximoTalhao").addEventListener("click", () => startNextTalhao());
  $("btnInsumosPosFim").addEventListener("click", () => onEventClick("LANCAMENTO_INSUMOS"));
  $("btnSemInsumoTalhao").addEventListener("click", () => concluirInsumosTalhao());
  $("btnConfirmProximoTalhao").addEventListener("click", () => startNextTalhaoFromForm());
  $("btnCancelProximoTalhao").addEventListener("click", () => closeModal());
  $("insumoSelect").addEventListener("change", updateInsumoUnidadeHint);
  $("btnConfirmInsumo").addEventListener("click", async () => {
    const id = parseInt($("insumoSelect").value, 10);
    const qtd = parseFloat($("insumoQtd").value);
    const ins = catalog.insumos.find((i) => i.id === id);
    if (!ins || !Number.isFinite(qtd) || qtd <= 0) {
      toast("Selecione insumo e quantidade");
      return;
    }
    const horaIns = promptHora("Horário do insumo (do apontamento)", horaPadrao());
    if (!horaIns) return;
    closeModal();
    const cicloId = insumoCicloId();
    if (navigator.onLine && turn.id) {
      try {
        await sbPost("campo_aplicacao_insumo", {
          client_insumo_id: crypto.randomUUID(),
          id_turno: turn.id,
          id_ciclo: cicloId,
          id_insumo_campo: ins.id,
          talhao_codigo: turn.talhao_codigo,
          quantidade: qtd,
          unidade: ins.unidade || "UN",
        });
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }
    await registerEvent("LANCAMENTO_INSUMOS", { hora: horaIns });
    turn.insumo_lancado_talhao = true;
    await concluirEtapaInsumosTalhao();
    toast(
      `${ins.descricao} ${qtd} ${ins.unidade || "UN"}. Use «Próximo talhão» ou «Fim operação».`
    );
  });
  $("btnCancelInsumo").addEventListener("click", () => closeModal());
  $("btnConfirmDeslocRetorno").addEventListener("click", () => confirmDeslocRetorno());
  $("btnCancelDeslocRetorno").addEventListener("click", () => closeModal());
  $("btnVoltarInicio").addEventListener("click", () => {
    refreshHomeButtons();
    showScreen("screenHome");
  });

  $("btnStep1Next").addEventListener("click", async () => {
    toast("Salvando turno…");
    const op = selectedOperacao();
    if (!op) {
      toast("Selecione a operação");
      return;
    }
    const btn = $("btnStep1Next");
    btn.disabled = true;
    try {
      const ok = await startWizardFlow();
      if (!ok || !turn) return;
      if (turn.estado_jornada === "OPERACAO_ATIVA") return;
      advanceWizardFromStep1();
    } catch (e) {
      console.error(e);
      toast(String(e.message || e).slice(0, 120), 7000);
    } finally {
      btn.disabled = false;
    }
  });

  $("btnStep2Next").addEventListener("click", () => {
    setWizardStep(3);
    $("horaChegada").value = horaPadrao();
  });

  $("btnStep3Next").addEventListener("click", () => {
    setWizardStep(4);
    $("hrOp").value = $("hrChegada").value || $("hrSaida").value;
    $("horaOp").value = $("horaChegada").value || horaPadrao();
  });

  $("btnIniciarJornada").addEventListener("click", () => finishDeslocAndCiclo());

  $("btnSync").addEventListener("click", async () => {
    try {
      await refreshNetStatus();
      await syncPendingTurn();
      await flushPendingEvents();
      await loadCatalogsOnline();
      await initCatalogs();
      await refreshTimeline();
      renderEventButtons();
      refreshPosCicloUI();
      toast("Atualizado / sincronizado");
    } catch (e) {
      toast(e.message);
    }
  });
}

boot();
