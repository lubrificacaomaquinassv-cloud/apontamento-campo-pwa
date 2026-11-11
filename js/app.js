/** Estado da jornada ativa (memória + IndexedDB) */
let catalog = null;
let turn = null; // { id, client_turn_id, seq, id_ciclo, ... }

const JOURNEY_BUTTONS = [
  { codigo: "PARADA_ALMOCO", label: "Parada almoço", hint: "Somente horário" },
  { codigo: "RETORNO_ALMOCO", label: "Retorno almoço", hint: "Horário do retorno" },
  { codigo: "PARADA_CLIMA", label: "Parada clima", hint: "Se não retornar → fim operação" },
  { codigo: "PARADA_MECANICA", label: "Parada mecânica", hint: "Horário e HR se houver" },
  { codigo: "RETORNO_OPERACAO", label: "Retorno operação", hint: "Após parada" },
  { codigo: "FIM_OPERACAO", label: "Fim operação", hint: "1 · Finaliza o talhão (HR)" },
  { codigo: "LANCAMENTO_INSUMOS", label: "Insumos", hint: "2 · Após fim operação", highlight: true },
  { codigo: "DESLOC_FRENTE_SEDE", label: "Desloc. retorno sede", hint: "Antes do fim do turno" },
  { codigo: "FINAL_TURNO", label: "Fim turno", hint: "Somente na sede" },
];

function turnoExigeDeslocRetorno() {
  return turn?.modo_deslocamento === "COM";
}

function etapaInsumosPendente() {
  return !!turn?.fase_pos_fim && operacaoExigeInsumo();
}

function podeEncerrarTurno() {
  if (!turn || turn.ciclo_ativo !== false) return false;
  if (etapaInsumosPendente()) return false;
  if (operacaoExigeInsumo() && !turn.insumos_talhao_concluido && !turn.insumo_lancado_talhao) {
    return false;
  }
  if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) return false;
  return true;
}

/** Após lançar insumo, libera próximo talhão / fim turno. */
async function concluirEtapaInsumosTalhao() {
  if (!turn?.fase_pos_fim && !turn?.insumo_lancado_talhao) return;
  turn.fase_pos_fim = false;
  turn.insumos_talhao_concluido = true;
  semInsumoConfirmPending = false;
  await Storage.saveActiveTurn(turn);
  refreshPosCicloUI();
  renderEventButtons();
}

let semInsumoConfirmPending = false;

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
    toast("Nada pendente neste talhão.");
    return;
  }
  if (operacaoExigeInsumo() && !turn.insumo_lancado_talhao) {
    if (!semInsumoConfirmPending) {
      semInsumoConfirmPending = true;
      $("btnSemInsumoTalhao").textContent = "Confirmar sem insumo";
      toast("Toque de novo em «Confirmar sem insumo» se não houve aplicação.", 6000);
      return;
    }
  }
  await concluirEtapaInsumosTalhao();
  toast("Talhão concluído — use «Próximo talhão» ou «Fim turno».");
}

function $(id) {
  return document.getElementById(id);
}

const APP_VERSION = "v21";

function readFrota() {
  const raw = ($("frotaPick").value || "").trim();
  const m = raw.match(/^(\d+[A-Za-z0-9]*)/);
  if (m) return m[1].toUpperCase();
  return raw.toUpperCase();
}

function readOperador() {
  return ($("operadorPick").value || "").trim().toUpperCase();
}

function wirePickCombos() {
  /* datalist — sem wiring extra */
}

function fillFrotaOperadorSelects() {
  const frotaList = $("frotaDatalist");
  frotaList.innerHTML = "";
  for (const f of catalog.frotas || []) {
    const opt = document.createElement("option");
    opt.value = f.modelo ? `${f.id_frota} — ${f.modelo}` : String(f.id_frota);
    frotaList.appendChild(opt);
  }

  const opList = $("operadorDatalist");
  opList.innerHTML = "";
  for (const c of catalog.colaboradores || []) {
    const opt = document.createElement("option");
    opt.value = String(c.nome);
    opList.appendChild(opt);
  }
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
    desloc_retorno_concluido: false,
    desloc_retorno_registrado: false,
    ciclo_ativo: false,
    fase_pos_fim: false,
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
  turn = null;
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

/** Pergunta horário real do fato (lançamento no fim do dia). */
function promptHora(label, fallback) {
  const def = fallback || nowTime();
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
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

async function registerEvent(codigo, extra = {}) {
  const evDef = catalog.eventos.find((e) => e.codigo === codigo);
  let hora = extra.hora;
  let horimetro = extra.horimetro;
  if (evDef?.exige_hora && !hora) {
    hora = prompt("Horário (HH:MM):", nowTime());
    if (!hora) return;
  }
  if (evDef?.exige_horimetro && horimetro == null) {
    const v = prompt("Horímetro:");
    if (v === null || v === "") return;
    horimetro = parseFloat(v);
  }
  const seq = await nextSeq();
  const row = {
    client_event_id: crypto.randomUUID(),
    id_turno: turn.id,
    id_ciclo: turn.id_ciclo,
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
  turn.last_hr = horimetro ?? turn.last_hr;
  await Storage.saveActiveTurn(turn);
  await refreshTimeline();
  toast(`${evDef?.nome || codigo} registrado`);
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
  $("retHoraSaida").value = nowTime();
  $("retHrSaida").value = String(turn.last_hr ?? "");
  $("retHoraChegada").value = nowTime();
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
  $("nextHoraOp").value = nowTime();
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
  const ciclo =
    turn.ciclo_ativo === false
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
    $("btnContinuar").textContent = "Continuar operação (próximo talhão)";
  } else {
    $("btnContinuar").textContent = "Continuar operação";
  }
}

function refreshPosCicloUI() {
  const aberto = turn && turn.status === "ABERTO" && turn.ciclo_ativo === false;
  $("posCicloActions").classList.toggle("hidden", !aberto);
  if (!aberto) return;
  const tal = turn.talhao_codigo || "—";
  if (turn.fase_pos_fim) {
    const exIn = operacaoExigeInsumo();
    $("posCicloHint").textContent = exIn
      ? `Talhão ${tal} finalizado — lance insumos ou «Sem insumo».`
      : `Trecho ${tal} finalizado — confirme para liberar o próximo.`;
    $("btnInsumosPosFim").classList.toggle("hidden", !exIn);
    $("btnSemInsumoTalhao").classList.remove("hidden");
    $("btnSemInsumoTalhao").textContent = exIn
      ? "Concluir talhão — próximo"
      : "Próximo retiro / talhão";
    $("btnProximoTalhao").classList.add("hidden");
  } else if (turn.insumos_talhao_concluido) {
    $("posCicloHint").textContent =
      `Talhão ${tal} concluído — «Próximo talhão» ou «Fim turno» (se acabou o dia).`;
    $("btnInsumosPosFim").classList.add("hidden");
    $("btnSemInsumoTalhao").classList.add("hidden");
    $("btnProximoTalhao").classList.remove("hidden");
  } else {
    $("posCicloHint").textContent = "Encerre o talhão ou conclua a etapa de insumos.";
    $("btnInsumosPosFim").classList.toggle("hidden", !turn.fase_pos_fim);
    $("btnSemInsumoTalhao").classList.toggle("hidden", !turn.fase_pos_fim);
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

  await registerEvent("PARADA_MUDANCA_TALHAO", {
    hora: nowTime(),
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
  if (turn.fase_pos_fim) {
    toast("Lance insumos ou «Sem insumo» antes do próximo talhão.");
    return;
  }
  if (!turn.insumos_talhao_concluido && turn.ciclo_ativo === false) {
    toast("Conclua insumos do talhão anterior.");
    return;
  }
  openModalProximoTalhao();
}

function renderEventButtons() {
  const wrap = $("eventButtons");
  wrap.innerHTML = "";
  const precisaDesloc =
    turnoExigeDeslocRetorno() && turn.ciclo_ativo === false && !turn.desloc_retorno_concluido;
  const deslocOpcional =
    !turnoExigeDeslocRetorno() && turn.ciclo_ativo === false && !turn.desloc_retorno_registrado;
  for (const b of JOURNEY_BUTTONS) {
    if (b.codigo === "LANCAMENTO_INSUMOS" && !operacaoExigeInsumo()) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    let cls = "btn-event" + (b.highlight ? " highlight" : "");
    if (b.codigo === "DESLOC_FRENTE_SEDE" && (precisaDesloc || deslocOpcional)) cls += " highlight";
    btn.className = cls;
    let hint = b.hint;
    if (b.codigo === "DESLOC_FRENTE_SEDE" && !turnoExigeDeslocRetorno()) {
      hint = "Opcional — voltou da frente à tarde";
    }
    btn.innerHTML = `${b.label}<small>${hint}</small>`;
    if (b.codigo === "LANCAMENTO_INSUMOS" && turn.ciclo_ativo !== false && !turn.fase_pos_fim) {
      btn.disabled = true;
      btn.innerHTML = `${b.label}<small>Após «Fim operação»</small>`;
    }
    if (b.codigo === "FIM_OPERACAO" && turn.ciclo_ativo === false) {
      btn.disabled = true;
    }
    if (b.codigo === "FINAL_TURNO" && !podeEncerrarTurno()) {
      btn.disabled = true;
      if (turn.ciclo_ativo !== false) {
        btn.innerHTML = `${b.label}<small>Feche o talhão antes (Fim operação)</small>`;
      } else if (etapaInsumosPendente()) {
        btn.innerHTML = `${b.label}<small>Lance insumos ou «Concluir talhão»</small>`;
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

async function onEventClick(codigo) {
  if (codigo === "LANCAMENTO_INSUMOS") {
    if (turn.ciclo_ativo !== false && !turn.fase_pos_fim) {
      toast("Ordem: 1 Fim operação → 2 Insumos → 3 Próximo talhão");
      return;
    }
    if (!catalog.insumos?.length) {
      toast("Catálogo de insumos vazio — sincronize online");
      return;
    }
    openModalInsumos();
    return;
  }
  if (codigo === "FIM_OPERACAO") {
    if (turn.ciclo_ativo === false) {
      toast("Use «Próximo talhão» ou retorno à sede / fim turno.");
      return;
    }
    const horaFim = promptHora("Horário fim operação", nowTime());
    if (!horaFim) return;
    if (
      !confirmarHoraRelogio(horaFim, [turn.hora_inicio_turno, $("horaTurno")?.value], "Fim operação")
    ) {
      return;
    }
    const hr = parseFloat(
      prompt("Horímetro fim operação:", String(turn.last_hr ?? ""))
    );
    if (!Number.isFinite(hr)) return;
    if (!validarHorimetro(hr, "Fim operação")) return;
    await registerEvent("FIM_OPERACAO", { hora: horaFim, horimetro: hr });
    if (turn.id_ciclo && (await canSyncNow())) {
      try {
        await sbPatch("campo_ciclo_operacao", `id=eq.${turn.id_ciclo}`, {
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
    if (operacaoExigeInsumo()) {
      turn.fase_pos_fim = true;
      turn.insumos_talhao_concluido = false;
      semInsumoConfirmPending = false;
      await Storage.saveActiveTurn(turn);
      refreshPosCicloUI();
      refreshHomeButtons();
      renderEventButtons();
      toast(`Talhão ${turn.talhao_codigo || "—"}: lance insumos (passo 2)`);
    } else {
      turn.fase_pos_fim = false;
      turn.insumos_talhao_concluido = true;
      await Storage.saveActiveTurn(turn);
      refreshPosCicloUI();
      refreshHomeButtons();
      renderEventButtons();
      toast("Sem insumo nesta operação — use «Próximo talhão» ou Fim turno");
    }
    return;
  }
  if (codigo === "DESLOC_FRENTE_SEDE") {
    if (turn.ciclo_ativo !== false) {
      toast("Encerre o talhão (Fim operação) antes do retorno à sede.");
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
    if (turn.ciclo_ativo !== false) {
      toast("Use «Fim operação» no talhão antes de encerrar o turno.");
      return;
    }
    if (etapaInsumosPendente()) {
      toast("Lance insumos ou toque «Concluir talhão — próximo» antes do fim do turno.");
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
    const horaFim = promptHora("Horário fim turno (na sede)", nowTime());
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
      turn = {
        ...existing,
        modo_deslocamento: modo,
        exige_insumo: op.exige_insumo,
        operacao_nome: op.nome,
        id_operacao_campo: op.id,
        desloc_retorno_concluido: existing.desloc_retorno_concluido ?? false,
        desloc_retorno_registrado: existing.desloc_retorno_registrado ?? false,
      };
      turn.seq = await loadTurnMaxSeq();
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
          desloc_retorno_concluido: false,
          desloc_retorno_registrado: false,
          ciclo_ativo: false,
          fase_pos_fim: false,
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
          turn = { ...existing, modo_deslocamento: modo, exige_insumo: op.exige_insumo };
          turn.seq = await loadTurnMaxSeq();
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
      msg = "Erro de versão do app — publique a v16 ou atualize a página.";
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

  wirePickCombos();
  $("operacao").addEventListener("change", onOperacaoChange);
  onOperacaoChange();

  $("btnNovoTurno").addEventListener("click", () => {
    setWizardStep(1);
    showScreen("screenWizard");
  });

  $("btnContinuar").addEventListener("click", () => {
    if (!turn || turn.status === "ENCERRADO") {
      toast("Nenhum turno aberto. Use «Novo turno».");
      refreshHomeButtons();
      return;
    }
    showJourney();
  });

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
    closeModal();
    const cicloId = insumoCicloId();
    if (navigator.onLine && turn.id) {
      await sbPost("campo_aplicacao_insumo", {
        client_insumo_id: crypto.randomUUID(),
        id_turno: turn.id,
        id_ciclo: cicloId,
        id_insumo_campo: ins.id,
        produto_texto: null,
        talhao_codigo: turn.talhao_codigo,
        retiro_id: turn.retiro_id,
        quantidade: qtd,
        unidade: ins.unidade || "UN",
      });
    }
    await registerEvent("LANCAMENTO_INSUMOS", { hora: nowTime() });
    turn.insumo_lancado_talhao = true;
    await concluirEtapaInsumosTalhao();
    toast(
      `${ins.descricao} ${qtd} ${ins.unidade || "UN"}. Pode usar «Próximo talhão» ou «Fim turno».`
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
    $("horaChegada").value = nowTime();
  });

  $("btnStep3Next").addEventListener("click", () => {
    setWizardStep(4);
    $("hrOp").value = $("hrChegada").value || $("hrSaida").value;
    $("horaOp").value = nowTime();
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
