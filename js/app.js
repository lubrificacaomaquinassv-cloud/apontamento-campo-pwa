/** Estado da jornada ativa (memória + IndexedDB) */
let catalog = null;
let turn = null; // { id, client_turn_id, seq, id_ciclo, ... }

const JOURNEY_BUTTONS = [
  { codigo: "PARADA_ALMOCO", label: "Parada almoço", hint: "Somente horário" },
  { codigo: "RETORNO_ALMOCO", label: "Retorno almoço", hint: "Horário do retorno" },
  { codigo: "PARADA_CLIMA", label: "Parada clima", hint: "Se não retornar → fim operação" },
  { codigo: "PARADA_MECANICA", label: "Parada mecânica", hint: "Horário e HR se houver" },
  { codigo: "RETORNO_OPERACAO", label: "Retorno operação", hint: "Após parada" },
  { codigo: "LANCAMENTO_INSUMOS", label: "Insumos", hint: "Até 5 itens", highlight: true },
  { codigo: "FIM_OPERACAO", label: "Fim operação", hint: "HR final do ciclo" },
  { codigo: "DESLOC_FRENTE_SEDE", label: "Desloc. retorno sede", hint: "HR saída e chegada" },
  { codigo: "FINAL_TURNO", label: "Fim turno", hint: "Encerra jornada" },
];

function $(id) {
  return document.getElementById(id);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3500);
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
  $("offlineBanner").classList.toggle("hidden", on);
  $("netLabel").textContent = on ? "Rede: online" : "Rede: offline";
  $("netLabel").className = on ? "ok" : "warn";
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
  catalog = await getCatalogs();
  fillSelect($("operacao"), catalog.operacoes, "id", (o) => o.nome);
  fillSelect($("origemLoc"), catalog.locais, "id", (l) => l.nome);
  fillSelect($("destinoLoc"), catalog.locais, "id", (l) => l.nome);
  fillSelect($("retiro"), catalog.locais, "id", (l) => l.nome);
  $("frotaList").innerHTML = catalog.frotas
    .map((f) => `<option value="${f.id_frota}">`)
    .join("");
  $("operadorList").innerHTML = catalog.colaboradores
    .map((c) => `<option value="${c.nome}">`)
    .join("");
}

async function nextSeq() {
  turn.seq = (turn.seq || 0) + 1;
  await Storage.saveActiveTurn(turn);
  return turn.seq;
}

async function pushEvent(row) {
  if (!navigator.onLine) {
    toast("Offline: evento guardado localmente (sync em breve).");
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
  if (!turn?.id || !navigator.onLine) {
    $("timeline").innerHTML = turn?.pendingEvents?.length
      ? `<div>${turn.pendingEvents.length} evento(s) pendentes offline</div>`
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

function renderJourneyHead() {
  $("journeyHead").innerHTML = `
    <strong>${turn.id_frota} · ${turn.operador}</strong>
    <span>${turn.operacao_nome || ""} · HR ${turn.last_hr ?? turn.horimetro_inicio_turno ?? "—"}</span>
    <span>Talhão ${turn.talhao_codigo || "—"} · Sync ${turn.sync_status || "PENDENTE"}</span>`;
}

function renderEventButtons() {
  const wrap = $("eventButtons");
  wrap.innerHTML = "";
  for (const b of JOURNEY_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-event" + (b.highlight ? " highlight" : "");
    btn.innerHTML = `${b.label}<small>${b.hint}</small>`;
    btn.addEventListener("click", () => onEventClick(b.codigo));
    wrap.appendChild(btn);
  }
}

async function onEventClick(codigo) {
  if (codigo === "LANCAMENTO_INSUMOS") {
    const prod = prompt("Insumo (nome ou SAP) — use tela completa na próxima versão:");
    if (!prod) return;
    const qtd = parseFloat(prompt("Quantidade:"));
    if (!Number.isFinite(qtd)) return;
    const ins = catalog.insumos.find(
      (i) => i.descricao.toUpperCase().includes(prod.toUpperCase()) || i.codigo_sap === prod
    );
    await sbPost("campo_aplicacao_insumo", {
      client_insumo_id: crypto.randomUUID(),
      id_turno: turn.id,
      id_ciclo: turn.id_ciclo,
      id_insumo_campo: ins?.id || null,
      produto_texto: ins ? null : prod,
      talhao_codigo: turn.talhao_codigo,
      retiro_id: turn.retiro_id,
      quantidade: qtd,
      unidade: ins?.unidade || "UN",
    });
    await registerEvent("LANCAMENTO_INSUMOS", { hora: nowTime() });
    return;
  }
  if (codigo === "FIM_OPERACAO") {
    const hr = parseFloat(prompt("Horímetro fim operação:"));
    if (!Number.isFinite(hr)) return;
    await registerEvent("FIM_OPERACAO", { hora: nowTime(), horimetro: hr });
    if (turn.id_ciclo) {
      await sbPatch("campo_ciclo_operacao", `id=eq.${turn.id_ciclo}`, {
        status: "FINALIZADO",
        hora_fim: nowTime(),
        horimetro_fim: hr,
        fechado_em: new Date().toISOString(),
      });
    }
    return;
  }
  if (codigo === "FINAL_TURNO") {
    const hr = parseFloat(prompt("Horímetro fim turno:"));
    if (!Number.isFinite(hr)) return;
    await registerEvent("FINAL_TURNO", { hora: nowTime(), horimetro: hr });
    await sbPatch("campo_turno", `id=eq.${turn.id}`, {
      status: "ENCERRADO",
      hora_fim_turno: nowTime(),
      horimetro_fim_turno: hr,
      encerrado_em: new Date().toISOString(),
      estado_jornada: "TURNO_ENCERRADO",
      sync_status: "SINCRONIZADO",
    });
    await Storage.clearActiveTurn();
    turn = null;
    toast("Turno encerrado");
    showScreen("screenHome");
    return;
  }
  await registerEvent(codigo, {});
}

async function startWizardFlow() {
  const op = selectedOperacao();
  if (!op) {
    toast("Selecione a operação");
    return;
  }
  const modo =
    op.deslocamento_modo === "NUNCA" ? "NAO_APLICA" : op.deslocamento_modo === "SEMPRE" ? "COM" : $("modoDesloc").value;
  const payload = {
    client_turn_id: crypto.randomUUID(),
    data: $("dataOp").value,
    id_frota: $("frota").value.trim().toUpperCase(),
    operador: $("operador").value.trim().toUpperCase(),
    id_operacao_campo: op.id,
    operacao_nome: op.nome,
    modo_deslocamento: modo,
    status: "ABERTO",
    estado_jornada: "TURNO_ABERTO",
    hora_inicio_turno: $("horaTurno").value,
    horimetro_inicio_turno: parseFloat($("hrTurno").value),
    sync_status: "PENDENTE",
  };
  if (!navigator.onLine) {
    turn = { ...payload, seq: 0, pending: true };
    await Storage.saveActiveTurn(turn);
    toast("Turno salvo offline — sync quando houver rede");
    showJourney();
    return;
  }
  const existing = await findOpenTurn(payload.data, payload.id_frota, payload.operador);
  if (existing) {
    if (!confirm("Já existe turno aberto hoje. Continuar nele?")) return;
    turn = { ...existing, seq: 0 };
  } else {
    const ins = await sbPost("campo_turno", payload);
    turn = { ...ins[0], seq: 0 };
  }
  turn.seq = 0;
  await nextSeq();
  await pushEvent({
    client_event_id: crypto.randomUUID(),
    id_turno: turn.id,
    seq: turn.seq,
    codigo_evento: "INICIO_TURNO",
    hora: $("horaTurno").value,
    horimetro: parseFloat($("hrTurno").value),
    origem: "PWA",
  });

  if (modo === "COM") {
    toast("Preencha deslocamento nos passos 2–3");
    return;
  }
}

async function finishDeslocAndCiclo() {
  let idDesloc = null;
  if (turn.modo_deslocamento === "COM" && navigator.onLine) {
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
  }
  const retiroId = parseInt($("retiro").value, 10);
  turn.talhao_codigo = $("talhaoCod").value.trim() || null;
  turn.retiro_id = retiroId;
  turn.last_hr = parseFloat($("hrOp").value);

  if (navigator.onLine) {
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
    await registerEvent("INICIO_OPERACAO", {
      hora: $("horaOp").value,
      horimetro: turn.last_hr,
      retiro_id: retiroId,
      talhao_codigo: turn.talhao_codigo,
    });
    await sbPatch("campo_turno", `id=eq.${turn.id}`, { estado_jornada: "OPERACAO_ATIVA" });
  }
  await Storage.saveActiveTurn(turn);
  showJourney();
}

function showJourney() {
  renderJourneyHead();
  renderEventButtons();
  refreshTimeline();
  showScreen("screenJourney");
  $("btnContinuar").classList.remove("hidden");
}

function onOperacaoChange() {
  const op = selectedOperacao();
  const wrap = $("wrapDeslocEscolha");
  if (!op) return;
  wrap.classList.toggle("hidden", op.deslocamento_modo !== "OPCIONAL");
}

async function boot() {
  updateNetStatus();
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);

  $("dataOp").value = todayISO();
  $("horaTurno").value = nowTime();
  $("horaOp").value = nowTime();

  try {
    await initCatalogs();
    $("syncLabel").textContent = "Catálogo: OK";
    $("syncLabel").className = "ok";
  } catch (e) {
    $("syncLabel").textContent = "Catálogo: erro";
    toast(e.message);
  }

  const saved = await Storage.getActiveTurn();
  if (saved?.id || saved?.pending) {
    turn = saved;
    $("btnContinuar").classList.remove("hidden");
  }

  $("operacao").addEventListener("change", onOperacaoChange);
  onOperacaoChange();

  $("btnNovoTurno").addEventListener("click", () => {
    setWizardStep(1);
    showScreen("screenWizard");
  });

  $("btnContinuar").addEventListener("click", () => {
    if (turn) showJourney();
  });

  $("btnStep1Next").addEventListener("click", async () => {
    const op = selectedOperacao();
    if (!op) return;
    await startWizardFlow();
    const modo = turn.modo_deslocamento;
    if (modo === "COM") {
      setWizardStep(2);
      $("horaSaida").value = nowTime();
      $("hrSaida").value = $("hrTurno").value;
    } else {
      setWizardStep(4);
      $("hrOp").value = $("hrTurno").value;
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
      await loadCatalogsOnline();
      await refreshTimeline();
      toast("Atualizado");
    } catch (e) {
      toast(e.message);
    }
  });
}

boot();
