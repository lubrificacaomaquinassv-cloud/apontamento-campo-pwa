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

function podeEncerrarTurno() {
  if (!turn || turn.ciclo_ativo !== false) return false;
  if (turn.fase_pos_fim) return false;
  if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) return false;
  return true;
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
  if (!turn?.fase_pos_fim) return;
  if (operacaoExigeInsumo() && !turn.insumo_lancado_talhao) {
    if (!confirm("Operação exige insumo. Confirmar «sem insumo» neste talhão?")) return;
  }
  turn.fase_pos_fim = false;
  turn.insumos_talhao_concluido = true;
  await Storage.saveActiveTurn(turn);
  refreshPosCicloUI();
  renderEventButtons();
  toast("Pode abrir o próximo talhão");
}

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
    $("posCicloHint").textContent =
      `Talhão ${tal} finalizado — lance insumos (se houver) e libere o próximo.`;
    $("btnInsumosPosFim").classList.remove("hidden");
    $("btnSemInsumoTalhao").classList.remove("hidden");
    $("btnProximoTalhao").classList.add("hidden");
  } else if (turn.insumos_talhao_concluido) {
    $("posCicloHint").textContent = `Talhão ${tal} concluído — abra o próximo talhão.`;
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
  for (const b of JOURNEY_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    let cls = "btn-event" + (b.highlight ? " highlight" : "");
    if (b.codigo === "DESLOC_FRENTE_SEDE" && precisaDesloc) cls += " highlight";
    btn.className = cls;
    btn.innerHTML = `${b.label}<small>${b.hint}</small>`;
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
      } else if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) {
        btn.innerHTML = `${b.label}<small>Use «Desloc. retorno sede» antes</small>`;
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
    turn.ciclo_ativo = false;
    turn.fase_pos_fim = true;
    turn.insumos_talhao_concluido = false;
    turn.insumo_lancado_talhao = false;
    turn.id_ciclo_fechado = turn.id_ciclo;
    turn.last_hr = hr;
    await Storage.saveActiveTurn(turn);
    refreshPosCicloUI();
    refreshHomeButtons();
    renderEventButtons();
    toast(`Talhão ${turn.talhao_codigo || "—"}: lance insumos (passo 2)`);
    return;
  }
  if (codigo === "DESLOC_FRENTE_SEDE") {
    if (turn.ciclo_ativo !== false) {
      toast("Encerre o talhão (Fim operação) antes do retorno à sede.");
      return;
    }
    if (turn.desloc_retorno_concluido) {
      toast("Retorno à sede já registrado — use Fim turno.");
      return;
    }
    openModalDeslocRetorno();
    return;
  }
  if (codigo === "FINAL_TURNO") {
    if (turn.ciclo_ativo !== false) {
      toast("Use «Fim operação» no talhão antes de encerrar o turno.");
      return;
    }
    if (turnoExigeDeslocRetorno() && !turn.desloc_retorno_concluido) {
      toast("Registre «Desloc. retorno sede» antes do fim do turno.");
      openModalDeslocRetorno();
      return;
    }
    const hr = parseFloat(
      prompt("Horímetro fim turno (na sede):", String(turn.last_hr ?? ""))
    );
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
    refreshHomeButtons();
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
  if (!$("frota").value.trim() || !$("operador").value.trim()) {
    toast("Preencha frota e operador");
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
    id_frota: $("frota").value.trim().toUpperCase(),
    operador: $("operador").value.trim().toUpperCase(),
    id_operacao_campo: op.id,
    operacao_nome: op.nome,
    exige_insumo: op.exige_insumo,
    modo_deslocamento: modo,
    status: "ABERTO",
    estado_jornada: "TURNO_ABERTO",
    hora_inicio_turno: $("horaTurno").value,
    horimetro_inicio_turno: hrTurno,
    sync_status: "PENDENTE",
  };
  if (!navigator.onLine) {
    turn = {
      ...payload,
      seq: 0,
      pending: true,
      desloc_retorno_concluido: modo !== "COM",
      ciclo_ativo: false,
      fase_pos_fim: false,
    };
    await Storage.saveActiveTurn(turn);
    toast("Offline — continue o wizard; sync depois");
    return true;
  }
  let resumed = false;
  try {
    const existing = await findOpenTurn(payload.data, payload.id_frota, payload.operador);
    if (existing) {
      if (!confirm("Já existe turno aberto hoje. Continuar nele?")) return false;
      turn = {
        ...existing,
        modo_deslocamento: modo,
        exige_insumo: op.exige_insumo,
        operacao_nome: op.nome,
        id_operacao_campo: op.id,
        desloc_retorno_concluido: existing.desloc_retorno_concluido ?? modo !== "COM",
      };
      turn.seq = await loadTurnMaxSeq();
      resumed = true;
      if (existing.estado_jornada === "OPERACAO_ATIVA") {
        await Storage.saveActiveTurn(turn);
        toast("Turno em andamento — abrindo jornada");
        showJourney();
        return true;
      }
    } else {
      const ins = await sbPost("campo_turno", payload);
      if (!ins?.[0]?.id) throw new Error("Turno não gravado");
      turn = {
        ...ins[0],
        seq: 0,
        exige_insumo: op.exige_insumo,
        desloc_retorno_concluido: modo !== "COM",
        ciclo_ativo: false,
        fase_pos_fim: false,
      };
    }
    if (turn.modo_deslocamento !== "COM") turn.desloc_retorno_concluido = true;

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
    toast(e.message || "Erro ao abrir turno — tente de novo");
    turn = null;
    return false;
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
    if (turn.ciclo_ativo === undefined && turn.id_ciclo) turn.ciclo_ativo = true;
    if (turn.ciclo_ativo === undefined && !turn.id_ciclo) turn.ciclo_ativo = false;
    if (turn.desloc_retorno_concluido === undefined) {
      turn.desloc_retorno_concluido = turn.modo_deslocamento !== "COM";
    }
  }
  refreshHomeButtons();

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
    await Storage.saveActiveTurn(turn);
    toast(
      `${ins.descricao} ${qtd} ${ins.unidade || "UN"}. Lance outro ou «Concluir talhão — próximo».`
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
    const op = selectedOperacao();
    if (!op) {
      toast("Selecione a operação");
      return;
    }
    $("btnStep1Next").disabled = true;
    try {
      const ok = await startWizardFlow();
      if (!ok || !turn) {
        toast("Não foi possível avançar. Veja a mensagem acima.");
        return;
      }
      if (turn.estado_jornada === "OPERACAO_ATIVA") return;
      showScreen("screenWizard");
      const modo = turn.modo_deslocamento || $("modoDesloc").value;
      if (modo === "COM") {
        setWizardStep(2);
        $("horaSaida").value = nowTime();
        $("hrSaida").value = $("hrTurno").value;
      } else {
        setWizardStep(4);
        $("hrOp").value = $("hrTurno").value;
      }
    } catch (e) {
      console.error(e);
      toast(e.message || "Erro inesperado");
    } finally {
      $("btnStep1Next").disabled = false;
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
