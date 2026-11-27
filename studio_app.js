/**
 * XR 사운드 디자인 스튜디오 — 단일 창 작업 흐름 컨트롤러 (UI / Audio / Canvas / SAM 2 연동)
 * 계산과 직렬화는 모두 window.StudioEngine 모듈을 통해 수행한다.
 */
(function () {
  'use strict';

  const E = window.StudioEngine;
  const SAMPLE_RATE = 48000;
  const SAM2_URL = 'http://127.0.0.1:8765';
  const AUTOSAVE_KEY = 'xr_studio_autosave_v2';
  const RECENTS_KEY = 'xr_studio_recents_v2';

  // ===========================================================================
  // 1. 애플리케이션 런타임 상태
  // ===========================================================================
  const app = {
    project: E.createDefaultProject('새 프로젝트'),
    scene: null,
    history: new E.HistoryStack(60),
    mode: 1, // 1:준비, 2:카메라, 3:대상, 4:장면, 5:소리, 6:출력
    viewLayout: 'video', // 'video' | 'top' | 'split'
    selected: { type: 'audio_setup', id: null }, // 'audio_setup' | 'camera' | 'yaw_kf' | 'target' | 'fixed' | 'source' | 'export'
    currentFrame: 1,
    loopRange: { enabled: false, start: 1, end: 900 },
    rotationCheckDeg: 0.0,
    listenRefMode: false, // false = 내 믹스, true = 레퍼런스(원음)

    overlays: {
      mask: true,
      box: true,
      refPoint: true,
      trail: true,
      horizon: true,
      meBox: true,
      grid: true
    },

    // 비디오 클릭 상태 (방향 마커 & 카메라 캘리브레이션 클릭 버퍼)
    clickMarker: { active: false, x: 640, y: 360, az: 0, el: 0 },
    camClickTool: 'horizon_2pt', // 'horizon_2pt' | 'parallel_4pt' | 'person_2pt' | 'none'
    camClickBuffer: [],

    // 탑뷰 뷰포트 변환 (줌·팬·드래그)
    topView: {
      zoom: 1.0,
      panX: 0,
      panY: 0,
      dragging: null // { kind: 'waypoint'|'fixed'|'pan', ... }
    },

    // 공용 타임라인 상태
    timeline: {
      collapsed: false,
      zoom: 1.0,
      scrollLeft: 0,
      laneCollapsed: {
        refWave: false,
        viewSeg: false,
        yawKf: false,
        targets: false,
        sources: false
      },
      dragging: null
    },

    // 오디오 & 렌더링 상태
    audioBuffers: new Map(), // fileName -> AudioBuffer
    refWaveformPeaks: null,  // Float32Array (비디오/레퍼런스 파형)
    refAudioBuffer: null,
    renderDirty: true,
    renderedBuffer: null,
    renderInfo: { peakBeforeLimit: 0, limiterGain: 1, appliedGain: 1 },

    // SAM 2 및 백그라운드 작업 상태
    server: {
      connected: false,
      device: '',
      ffmpeg: false,
      sessionId: null,
      videoFileBlob: null,
      prepWidth: 640,
      prepStride: 3,
      prepared: false,
      serverTargetMap: new Map(), // target.id -> server numeric target_id
      maskCache: new Map(),       // `${targetId}:${frame}` -> HTMLCanvasElement
      maskLoadingKey: null
    },
    bgJob: {
      active: false,
      title: '',
      progress: 0,
      cancellable: false,
      onCancel: null
    },
    warnings: [],
    lastError: '',
    saveStatus: '저장 전',
    autoSaveTimer: null,
    dirtySinceSave: false
  };

  // Web Audio 실시간 엔진 노드
  let audioCtx = null;
  let masterGainNode = null;
  let speakerAnalysers = [null, null, null, null];
  let speakerBusGains = [null, null, null, null];
  let reverbConvolver = null;
  let reverbWetBus = null;
  let liveNodes = []; // 재생 중 활성 소스 노드 묶음
  let liveRefNode = null;
  let liveRefGain = null;
  let isPlaying = false;
  let playStartCtxTime = 0;
  let playStartSec = 0;
  let animFrameId = null;
  let builtinMovingBuf = null;
  let builtinChannelBuf = null;

  // DOM 참조 캐시
  const dom = {};

  // ===========================================================================
  // 2. 초기화 및 히스토리 · 자동 저장 관리
  // ===========================================================================
  function cacheDom() {
    const ids = [
      'inpProjectName', 'recentProjectsSelect', 'btnUndo', 'btnRedo',
      'renderStatusBadge', 'btnRenderNow', 'btnPlayPause', 'timeReadout',
      'btnRefToggle', 'slRotCheck', 'lblRotCheck', 'btnModeDownmix', 'btnModeMulti',
      'btnServerStatus', 'checklistBox', 'accOralBody', 'accCamSummary',
      'targetsListBox', 'fixedListBox', 'sourcesListBox',
      'ovHFov', 'ovPersonH', 'ovEyeH', 'ovSoundH', 'ovTurnDeg', 'ovNearDist',
      'ovAttenRef', 'ovAttenK', 'ovConfThresh', 'knownSizesBox',
      'btnViewVideo', 'btnViewTop', 'btnViewSplit', 'clickHintBadge',
      'viewportGrid', 'videoPane', 'topViewPane', 'vVideo', 'videoCanvas', 'vDropOverlay',
      'topViewCanvas', 'hudDirText', 'hudDistText', 'hudCamText',
      'miniMeterFL', 'miniMeterFR', 'miniMeterRL', 'miniMeterRR',
      'inspectorTitle', 'inspectorBody',
      'timelineBody', 'timelineCanvas', 'timelineScrollWrap', 'slTimelineZoom', 'btnCollapseTimeline',
      'warnBadgeBtn', 'warnPopover', 'warnPopoverList',
      'bgJobBox', 'bgJobTitle', 'bgJobProgress', 'btnBgCancel',
      'statusMessage', 'saveStatusText', 'helpModal',
      'fileInputVideo', 'fileInputProject', 'fileInputAudio', 'fileInputRefAudio'
    ];
    ids.forEach(id => { dom[id] = document.getElementById(id); });
  }

  function recordUndoSnapshot() {
    app.history.push(E.serializeSettingsJson(app.project));
    updateUndoRedoButtons();
    scheduleAutoSave();
  }

  function updateUndoRedoButtons() {
    if (dom.btnUndo) dom.btnUndo.disabled = !app.history.canUndo();
    if (dom.btnRedo) dom.btnRedo.disabled = !app.history.canRedo();
  }

  function performUndo() {
    const cur = E.serializeSettingsJson(app.project);
    const prev = app.history.undo(cur);
    if (!prev) return;
    restoreFromJsonSnapshot(prev, '되돌리기 완료');
    updateUndoRedoButtons();
  }

  function performRedo() {
    const cur = E.serializeSettingsJson(app.project);
    const next = app.history.redo(cur);
    if (!next) return;
    restoreFromJsonSnapshot(next, '다시 하기 완료');
    updateUndoRedoButtons();
  }

  function restoreFromJsonSnapshot(jsonStr, msg) {
    app.project = E.deserializeSettingsJson(jsonStr);
    rebindAudioBuffersToSources();
    syncOralInputsFromProject();
    recomputeAll(true);
    setStatusMessage(msg);
  }

  function scheduleAutoSave() {
    app.dirtySinceSave = true;
    app.saveStatus = '변경됨 (자동 저장 대기)';
    if (dom.saveStatusText) dom.saveStatusText.textContent = app.saveStatus;
    if (app.autoSaveTimer) clearTimeout(app.autoSaveTimer);
    app.autoSaveTimer = setTimeout(() => {
      saveToLocalStorage();
    }, 30000);
  }

  function saveToLocalStorage() {
    try {
      const json = E.serializeSettingsJson(app.project);
      localStorage.setItem(AUTOSAVE_KEY, json);
      pushRecentProject(app.project.project_name || '프로젝트', json);
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      app.dirtySinceSave = false;
      app.saveStatus = `자동 저장됨 ${hh}:${mm}:${ss}`;
      if (dom.saveStatusText) dom.saveStatusText.textContent = app.saveStatus;
    } catch (err) {
      logError(`자동 저장 실패: ${err.message}`);
    }
  }

  function pushRecentProject(name, json) {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      const filtered = raw.filter(item => item.name !== name);
      filtered.unshift({ name, savedAt: new Date().toLocaleString('ko-KR'), json });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(filtered.slice(0, 6)));
      renderRecentProjectsDropdown();
    } catch (_) {}
  }

  function renderRecentProjectsDropdown() {
    if (!dom.recentProjectsSelect) return;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch (_) {}
    dom.recentProjectsSelect.innerHTML = '<option value="">최근 프로젝트</option>' +
      list.map((it, idx) => `<option value="${idx}">${esc(it.name)} (${esc(it.savedAt)})</option>`).join('');
  }

  // ===========================================================================
  // 3. 핵심 재계산 파이프라인 (장면 그래프 · 경고 · UI 동기화)
  // ===========================================================================
  function recomputeAll(markRenderDirty) {
    if (markRenderDirty) {
      app.renderDirty = true;
      app.renderedBuffer = null;
    }
    app.scene = E.computeSceneGraph(app.project);
    app.currentFrame = E.clamp(app.currentFrame, 1, app.scene.totalFrames);
    app.warnings = E.runPreflightCheck(app.project, app.scene, app.renderInfo);
    updateTopBarUI();
    renderChecklist();
    renderLeftLists();
    renderInspector();
    requestViewportRedraw();
    if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
  }

  function setStatusMessage(msg) {
    if (dom.statusMessage) dom.statusMessage.textContent = msg;
  }

  function logError(msg) {
    app.lastError = msg;
    app.warnings.unshift({ level: 'error', mode: app.mode, message: msg });
    updateWarningUI();
    setStatusMessage(`오류: ${msg}`);
  }

  function setBgJob(active, title, progress, cancellable, onCancel) {
    app.bgJob = { active, title: title || '', progress: progress || 0, cancellable: Boolean(cancellable), onCancel: onCancel || null };
    if (!dom.bgJobBox) return;
    dom.bgJobBox.style.display = active ? 'flex' : 'none';
    dom.bgJobTitle.textContent = title || '';
    dom.bgJobProgress.value = E.clamp(progress || 0, 0, 100);
    dom.btnBgCancel.style.display = cancellable ? 'inline-flex' : 'none';
  }

  // ===========================================================================
  // 4. 작업 모드 (①~⑥) 및 할 일 체크리스트
  // ===========================================================================
  const MODE_DEFS = {
    1: {
      name: '① 준비',
      clickHint: '영상 클릭: 화각 기준 방향(방위각·고도) 확인',
      overlays: { horizon: false, mask: false, box: false, refPoint: false, trail: false, meBox: false, grid: true },
      tasks: [
        { key: 'm1_video', label: '영상 열기', check: p => Boolean(p.video.file) },
        { key: 'm1_oral', label: '설정값(화각·키·거리) 입력', check: p => Number(p.video.hfov_deg) > 0 && Number(p.oral_values.person_height_m) > 0 },
        { key: 'm1_audio', label: '출력 장치 확인 (테스트 톤)', check: p => Boolean(p.studio.checklist_done.m1_audio) }
      ]
    },
    2: {
      name: '② 카메라',
      clickHint: '영상 클릭: 지평선 / 소실점 평행선 / 사람 발·머리 지정',
      overlays: { horizon: true, meBox: true, grid: true },
      tasks: [
        { key: 'm2_hz', label: '지평선 확인·보정', check: p => p.camera.horizon.corrections.length > 0 || p.camera.horizon.auto_profile.length > 0 || p.camera.horizon.method === 'pitch_input' || Boolean(p.studio.checklist_done.m2_hz) },
        { key: 'm2_me', label: "'나' 대상 지정 (없으면 생략 체크)", check: p => Boolean(p.camera.me_target) || Boolean(p.studio.checklist_done.m2_me) },
        { key: 'm2_view', label: '시점 구간 확인', check: p => p.camera.view_segments.length >= 1 && (Boolean(p.studio.checklist_done.m2_view) || p.camera.view_segments.length > 1) },
        { key: 'm2_height', label: '카메라 높이 설정', check: p => Number(p.camera.height.first_person_m) > 0 },
        { key: 'm2_yaw', label: '수평 회전 확인·키프레임', check: p => p.camera.yaw_keyframes.length > 0 || Boolean(p.studio.checklist_done.m2_yaw) }
      ]
    },
    3: {
      name: '③ 대상',
      clickHint: '좌클릭 = 대상 포함 · 우클릭 = 배경 제외 (수동 모드는 위치 찍기)',
      overlays: { mask: true, box: true, refPoint: true, trail: true, horizon: true },
      tasks: [
        { key: 'm3_add', label: '추적 대상 추가', check: p => p.targets.length > 0 },
        { key: 'm3_seed', label: '대상 클릭 선택 (프롬프트/키프레임)', check: p => p.targets.some(t => (t.prompts && t.prompts.length > 0) || (t.manual_keyframes && t.manual_keyframes.length > 0)) },
        { key: 'm3_track', label: '양방향 추적 실행', check: p => p.targets.some(t => Object.keys(t.raw_frames || {}).length > 1 || (t.manual_keyframes && t.manual_keyframes.length > 1)) },
        { key: 'm3_unc', label: '불확실 구간 확인·보정', check: (p, sc) => p.targets.length > 0 && p.targets.every(t => !sc || (sc.targetTracks[t.id] && sc.targetTracks[t.id].uncertainSpans.length === 0)) || Boolean(p.studio.checklist_done.m3_unc) },
        { key: 'm3_dist', label: '거리 방법·크기 확인', check: p => p.targets.length > 0 && p.targets.every(t => t.distance_method === 'ground_contact' || (t.size_key && p.oral_values.known_sizes_m[t.size_key] > 0)) }
      ]
    },
    4: {
      name: '④ 장면',
      clickHint: '영상 땅 클릭 = 고정 음원 추가 | 탑뷰 드래그 = 경유점·고정음원 이동, 더블클릭 = 경유점 추가',
      overlays: { horizon: true, trail: true, refPoint: true },
      tasks: [
        { key: 'm4_top', label: '탑뷰에서 동선·시야 확인', check: p => Boolean(p.studio.checklist_done.m4_top) || app.viewLayout !== 'video' },
        { key: 'm4_gap', label: '화면 밖 구간 잇기·경유점 편집', check: (p, sc) => (sc && Object.values(sc.targetTracks).every(tr => tr.unbridgedGaps === 0)) || Boolean(p.studio.checklist_done.m4_gap) },
        { key: 'm4_ext', label: '처음·끝 연장 확인', check: p => p.targets.some(t => t.extend_start !== 'none' || t.extend_end !== 'none') || Boolean(p.studio.checklist_done.m4_ext) },
        { key: 'm4_fix', label: '고정 음원 배치 (필요 시)', check: p => p.fixed_sources.length > 0 || Boolean(p.studio.checklist_done.m4_fix) },
        { key: 'm4_ref', label: '청취 기준(카메라 / 나) 확인', check: p => p.listener.reference === 'camera' || p.listener.reference === 'me' }
      ]
    },
    5: {
      name: '⑤ 소리',
      clickHint: '타임라인 블록 드래그 = 시작 프레임 이동 | R = 레퍼런스/내 믹스 전환',
      overlays: { box: true, refPoint: true, trail: true },
      tasks: [
        { key: 'm5_add', label: '음원 파일 추가', check: p => p.sources.length > 0 },
        { key: 'm5_q', label: '분류 질문 3개·전달 방식 설정', check: p => p.sources.length > 0 && p.sources.every(s => Boolean(s.delivery)) },
        { key: 'm5_link', label: '대상 동선·고정 위치·채널 연결', check: p => p.sources.length > 0 && p.sources.every(s => s.delivery !== 'Object' || (s.link && (s.link.target || s.link.fixed)) || s._customPath) },
        { key: 'm5_start', label: '시작 프레임 배치 (레퍼런스 파형 대조)', check: p => p.sources.length > 0 && p.sources.every(s => s.start_frame >= 1) },
        { key: 'm5_mix', label: '음량·청감·회전 확인', check: p => Boolean(p.studio.checklist_done.m5_mix) || !app.renderDirty }
      ]
    },
    6: {
      name: '⑥ 출력',
      clickHint: '경고 항목을 클릭하면 해당 설정으로 바로 이동합니다',
      overlays: { box: true, trail: true, horizon: true },
      tasks: [
        { key: 'm6_check', label: '사전 점검 경고 확인', check: () => app.warnings.filter(w => w.level === 'error').length === 0 },
        { key: 'm6_export', label: '파일 내보내기 / 압축 생성', check: p => Boolean(p.studio.checklist_done.m6_export) }
      ]
    }
  };

  function setMode(modeNum) {
    const m = E.clamp(Number(modeNum) || 1, 1, 6);
    app.mode = m;
    const def = MODE_DEFS[m];

    // 모드별 기본 겹쳐보기 반영
    Object.entries(def.overlays).forEach(([k, v]) => { app.overlays[k] = v; });
    syncOverlayButtons();

    // 모드별 뷰포트 & 인스펙터 & 타임라인 자동 포커스
    if (m === 1) {
      app.selected = { type: 'audio_setup', id: null };
    } else if (m === 2) {
      app.selected = { type: 'camera', id: null };
      app.timeline.laneCollapsed.viewSeg = false;
      app.timeline.laneCollapsed.yawKf = false;
    } else if (m === 3) {
      if (app.selected.type !== 'target' || !app.project.targets.some(t => t.id === app.selected.id)) {
        app.selected = app.project.targets.length
          ? { type: 'target', id: app.project.targets[0].id }
          : { type: 'target', id: null };
      }
      app.timeline.laneCollapsed.targets = false;
    } else if (m === 4) {
      if (app.viewLayout === 'video') setViewLayout('split');
      app.project.studio.checklist_done.m4_top = true;
      if (app.selected.type !== 'fixed' && app.selected.type !== 'target') {
        app.selected = { type: 'scene', id: null };
      }
    } else if (m === 5) {
      if (app.selected.type !== 'source' || !app.project.sources.some(s => s.id === app.selected.id)) {
        app.selected = app.project.sources.length
          ? { type: 'source', id: app.project.sources[0].id }
          : { type: 'source', id: null };
      }
      app.timeline.laneCollapsed.sources = false;
      app.timeline.laneCollapsed.refWave = false;
    } else if (m === 6) {
      app.selected = { type: 'export', id: null };
    }

    // 왼쪽 아코디언 자동 펼침
    document.querySelectorAll('.left-acc').forEach(el => {
      const targetModes = (el.dataset.modes || '').split(',');
      if (targetModes.includes(String(m))) el.classList.add('open');
    });

    updateTopBarUI();
    renderChecklist();
    renderLeftLists();
    renderInspector();
    requestViewportRedraw();
  }

  function renderChecklist() {
    const def = MODE_DEFS[app.mode];
    if (!dom.checklistBox || !def) return;
    const rows = def.tasks.map(task => {
      const done = task.check(app.project, app.scene);
      return `<label class="chk-task-item ${done ? 'done' : ''}">
        <input type="checkbox" ${done ? 'checked' : ''} onchange="StudioApp.toggleManualCheck('${task.key}', this.checked)">
        <span>${esc(task.label)}</span>
      </label>`;
    }).join('');
    dom.checklistBox.innerHTML = `<div class="chk-title">${esc(def.name)} 할 일 체크리스트</div>${rows}`;
  }

  function toggleManualCheck(key, checked) {
    app.project.studio.checklist_done[key] = Boolean(checked);
    updateTopBarUI();
    renderChecklist();
    scheduleAutoSave();
  }

  function updateTopBarUI() {
    if (dom.inpProjectName && document.activeElement !== dom.inpProjectName) {
      dom.inpProjectName.value = app.project.project_name || '새 프로젝트';
    }
    for (let m = 1; m <= 6; m++) {
      const btn = document.getElementById(`modeBtn${m}`);
      if (!btn) continue;
      btn.classList.toggle('active', app.mode === m);
      const tasks = MODE_DEFS[m].tasks;
      const doneCount = tasks.filter(t => t.check(app.project, app.scene)).length;
      const allDone = doneCount === tasks.length;
      const badge = btn.querySelector('.mode-done');
      if (badge) {
        badge.textContent = allDone ? '✓' : `${doneCount}/${tasks.length}`;
        badge.classList.toggle('complete', allDone);
      }
    }

    if (dom.clickHintBadge) dom.clickHintBadge.textContent = MODE_DEFS[app.mode].clickHint;

    if (dom.renderStatusBadge) {
      if (app.renderDirty) {
        dom.renderStatusBadge.textContent = '갱신 필요';
        dom.renderStatusBadge.className = 'badge-pill warn';
      } else {
        dom.renderStatusBadge.textContent = '렌더 최신';
        dom.renderStatusBadge.className = 'badge-pill ok';
      }
    }

    if (dom.btnRefToggle) {
      dom.btnRefToggle.textContent = app.listenRefMode ? '🎧 레퍼런스 듣는 중 (R)' : '🔊 내 4ch 믹스 (R)';
      dom.btnRefToggle.classList.toggle('active-ref', app.listenRefMode);
    }

    const outMode = app.project.studio.output_mode || 'downmix';
    if (dom.btnModeDownmix) dom.btnModeDownmix.classList.toggle('active', outMode === 'downmix');
    if (dom.btnModeMulti) dom.btnModeMulti.classList.toggle('active', outMode === 'multichannel');

    updateFrameReadout();
    updateWarningUI();
  }

  function updateWarningUI() {
    if (!dom.warnBadgeBtn) return;
    const count = app.warnings.length;
    const errCount = app.warnings.filter(w => w.level === 'error').length;
    dom.warnBadgeBtn.textContent = count === 0 ? '✓ 경고 0' : `⚠️ 경고 ${count}${errCount ? ` (오류 ${errCount})` : ''}`;
    dom.warnBadgeBtn.className = 'status-warn-btn ' + (errCount > 0 ? 'has-error' : (count > 0 ? 'has-warn' : 'clean'));
    if (dom.warnPopoverList) {
      dom.warnPopoverList.innerHTML = count === 0
        ? '<div style="padding:8px;color:#94a3b8;">모든 사전 점검 항목이 정상입니다.</div>'
        : app.warnings.map((w, idx) => `
          <div class="warn-row ${w.level}" onclick="StudioApp.jumpToWarning(${idx})">
            <span class="warn-tag">${w.level === 'error' ? '오류' : '주의'} · 모드 ${w.mode}</span>
            <span>${esc(w.message)}</span>
          </div>`).join('');
    }
  }

  function jumpToWarning(idx) {
    const w = app.warnings[idx];
    if (!w) return;
    dom.warnPopover.style.display = 'none';
    setMode(w.mode || 6);
  }

  // ===========================================================================
  // 5. 설정값(구두 값) 단일 입력 패널 & 왼쪽 목록 렌더링
  // ===========================================================================
  function syncOralInputsFromProject() {
    const p = app.project;
    const ov = p.oral_values;
    const setVal = (el, v) => { if (el && document.activeElement !== el) el.value = v ?? ''; };
    setVal(dom.ovHFov, p.video.hfov_deg ?? 60);
    setVal(dom.ovPersonH, ov.person_height_m ?? 1.7);
    setVal(dom.ovEyeH, ov.eye_height_m ?? 1.6);
    setVal(dom.ovSoundH, ov.sound_height_m ?? 1.2);
    setVal(dom.ovTurnDeg, ov.turn_angle_deg ?? 90);
    setVal(dom.ovNearDist, ov.near_threshold_m ?? 1.5);
    setVal(dom.ovAttenRef, ov.atten_ref_m ?? 2.0);
    setVal(dom.ovAttenK, ov.atten_k ?? 1.0);
    setVal(dom.ovConfThresh, ov.confidence_threshold ?? 0.5);
    renderKnownSizesEditor();
  }

  function renderKnownSizesEditor() {
    if (!dom.knownSizesBox) return;
    const map = app.project.oral_values.known_sizes_m || {};
    const entries = Object.entries(map);
    dom.knownSizesBox.innerHTML = entries.map(([k, v]) => `
      <div class="known-size-row">
        <input type="text" value="${esc(k)}" placeholder="이름 (예: heli_length)" onchange="StudioApp.renameKnownSize('${escJs(k)}', this.value)">
        <input type="number" step="0.1" min="0.05" value="${Number(v)}" onchange="StudioApp.updateKnownSize('${escJs(k)}', this.value)">
        <span class="unit-lbl">m</span>
        <button class="btn-icon" title="삭제" onclick="StudioApp.deleteKnownSize('${escJs(k)}')">✕</button>
      </div>
    `).join('') + (entries.length < 4
      ? `<button class="btn-xs btn-secondary" style="width:100%;margin-top:4px;" onclick="StudioApp.addKnownSize()">+ 대상 기준 크기 추가</button>`
      : '');
  }

  function onOralValueInput() {
    recordUndoSnapshot();
    const p = app.project;
    const ov = p.oral_values;
    const numOrNull = (el, fb) => {
      if (!el || el.value === '') return fb;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : fb;
    };
    p.video.hfov_deg = E.clamp(numOrNull(dom.ovHFov, 60), 5, 175);
    ov.person_height_m = numOrNull(dom.ovPersonH, 1.7);
    ov.eye_height_m = numOrNull(dom.ovEyeH, 1.6);
    p.camera.height.first_person_m = ov.eye_height_m;
    p.listener.me_ear_height_m = ov.eye_height_m;
    ov.sound_height_m = numOrNull(dom.ovSoundH, 1.2);
    ov.turn_angle_deg = numOrNull(dom.ovTurnDeg, 90);
    ov.near_threshold_m = numOrNull(dom.ovNearDist, 1.5);
    ov.atten_ref_m = numOrNull(dom.ovAttenRef, 2.0);
    ov.atten_k = numOrNull(dom.ovAttenK, 1.0);
    ov.confidence_threshold = E.clamp(numOrNull(dom.ovConfThresh, 0.5), 0.05, 0.99);

    if (app.clickMarker.active && app.scene) {
      const intr = E.computeIntrinsics(p.video);
      const { azCam, elCam } = E.pixelToCameraAngles(app.clickMarker.x, app.clickMarker.y, intr, 0);
      app.clickMarker.az = azCam;
      app.clickMarker.el = elCam;
    }
    recomputeAll(true);
  }

  function addKnownSize() {
    recordUndoSnapshot();
    const map = app.project.oral_values.known_sizes_m;
    let idx = Object.keys(map).length + 1;
    while (map[`size_${idx}`] !== undefined) idx++;
    map[`size_${idx}`] = 2.0;
    renderKnownSizesEditor();
    recomputeAll(true);
  }

  function renameKnownSize(oldKey, newKey) {
    const clean = String(newKey || '').trim().replace(/\s+/g, '_');
    if (!clean || clean === oldKey) { renderKnownSizesEditor(); return; }
    recordUndoSnapshot();
    const map = app.project.oral_values.known_sizes_m;
    const val = map[oldKey];
    delete map[oldKey];
    map[clean] = val;
    app.project.targets.forEach(t => { if (t.size_key === oldKey) t.size_key = clean; });
    renderKnownSizesEditor();
    recomputeAll(true);
  }

  function updateKnownSize(key, val) {
    recordUndoSnapshot();
    app.project.oral_values.known_sizes_m[key] = Math.max(0.05, Number(val) || 1.0);
    recomputeAll(true);
  }

  function deleteKnownSize(key) {
    recordUndoSnapshot();
    delete app.project.oral_values.known_sizes_m[key];
    renderKnownSizesEditor();
    recomputeAll(true);
  }

  function renderLeftLists() {
    const p = app.project;
    // 카메라 요약
    if (dom.accCamSummary) {
      const selected = app.selected.type === 'camera' || app.selected.type === 'yaw_kf';
      dom.accCamSummary.innerHTML = `
        <div class="list-row ${selected ? 'selected' : ''}" onclick="StudioApp.selectItem('camera', null)">
          <div>
            <div style="font-weight:700;">🎥 카메라 · 지평선 · 회전</div>
            <div class="sub-txt">지평선: ${esc(p.camera.horizon.method)} · 나: ${esc(p.camera.me_target || '없음')} · 회전 ${p.camera.yaw_keyframes.length}개 · 기준: ${p.listener.reference === 'me' ? "'나'" : '카메라'}</div>
          </div>
        </div>`;
    }

    // 대상 목록
    if (dom.targetsListBox) {
      if (!p.targets.length) {
        dom.targetsListBox.innerHTML = '<div class="empty-hint">추적 대상이 없습니다. [+ 대상 추가]를 누르세요.</div>';
      } else {
        dom.targetsListBox.innerHTML = p.targets.map((t, idx) => {
          const sel = app.selected.type === 'target' && app.selected.id === t.id;
          const tr = app.scene && app.scene.targetTracks[t.id];
          const visCnt = tr ? tr.frames.filter(fr => fr && fr.visible).length : 0;
          const uncCnt = tr ? tr.uncertainSpans.length : 0;
          const color = TARGET_COLORS[idx % TARGET_COLORS.length];
          return `<div class="list-row ${sel ? 'selected' : ''}" onclick="StudioApp.selectItem('target', '${escJs(t.id)}')">
            <span class="color-dot" style="background:${color};"></span>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;display:flex;justify-content:space-between;gap:4px;">
                <span class="ellipsis">${esc(t.id)}</span>
                <span class="mini-tag">${t.kind === 'ground' ? '땅 위' : '공중'}</span>
              </div>
              <div class="sub-txt">관측 ${visCnt}f${tr && tr.nearest ? ` · 최근접 ${tr.nearest.distance_m}m` : ''}${uncCnt ? ` · <span style="color:#fbbf24;">불확실 ${uncCnt}</span>` : ''}</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    // 고정 음원 목록
    if (dom.fixedListBox) {
      if (!p.fixed_sources.length) {
        dom.fixedListBox.innerHTML = '<div class="empty-hint">고정 음원이 없습니다 (④ 장면에서 땅 클릭).</div>';
      } else {
        dom.fixedListBox.innerHTML = p.fixed_sources.map(fx => {
          const sel = app.selected.type === 'fixed' && app.selected.id === fx.id;
          const [x, y, z] = fx.scene_xyz_m || [0, 0, 0];
          return `<div class="list-row ${sel ? 'selected' : ''}" onclick="StudioApp.selectItem('fixed', '${escJs(fx.id)}')">
            <span>📌</span>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;">${esc(fx.id)}</div>
              <div class="sub-txt">[${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}] m</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    // 음원 목록 (줄마다 M / S / 실시간 볼륨 슬라이더!)
    if (dom.sourcesListBox) {
      if (!p.sources.length) {
        dom.sourcesListBox.innerHTML = '<div class="empty-hint">음원 파일을 끌어 놓거나 [+ 음원 추가]를 누르세요.</div>';
      } else {
        dom.sourcesListBox.innerHTML = p.sources.map(s => {
          const sel = app.selected.type === 'source' && app.selected.id === s.id;
          const col = TYPE_COLORS[s.type] || '#38bdf8';
          return `<div class="source-list-item ${sel ? 'selected' : ''}" onclick="StudioApp.selectItem('source', '${escJs(s.id)}')">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
              <div style="min-width:0;display:flex;align-items:center;gap:5px;">
                <span class="type-pill" style="background:${col}22;color:${col};border:1px solid ${col}66;">${esc(s.type)}</span>
                <span class="ellipsis" style="font-weight:700;font-size:11px;">${esc(s.id)}</span>
              </div>
              <div style="display:flex;gap:3px;" onclick="event.stopPropagation()">
                <button class="btn-ms ${s.muted ? 'active-m' : ''}" title="음소거 (M)" onclick="StudioApp.toggleSourceMute('${escJs(s.id)}')">M</button>
                <button class="btn-ms ${s.solo ? 'active-s' : ''}" title="솔로 (S)" onclick="StudioApp.toggleSourceSolo('${escJs(s.id)}')">S</button>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;" onclick="event.stopPropagation()">
              <input type="range" min="-30" max="12" step="0.5" value="${Number(s.gain_db) || 0}" style="flex:1;height:4px;"
                oninput="StudioApp.setSourceGainLive('${escJs(s.id)}', this.value, this.nextElementSibling)">
              <span class="gain-readout">${(Number(s.gain_db) || 0) >= 0 ? '+' : ''}${(Number(s.gain_db) || 0).toFixed(1)}dB</span>
            </div>
            <div class="sub-txt">${esc(s.delivery)} · f${s.start_frame}~${s.end_frame ?? '끝'}${s._hasBuffer ? '' : ' · <span style="color:#f87171;">파일 미연결</span>'}</div>
          </div>`;
        }).join('');
      }
    }
  }

  function selectItem(type, id) {
    app.selected = { type, id };
    renderLeftLists();
    renderInspector();
    requestViewportRedraw();
  }

  // ===========================================================================
  // 6. 오른쪽 속성 칸 (Context-Sensitive Inspector)
  // ===========================================================================
  const TARGET_COLORS = ['#22c55e', '#38bdf8', '#f59e0b', '#ec4899', '#a855f7', '#14b8a6'];
  const TYPE_COLORS = { DX: '#38bdf8', FX: '#f59e0b', MX: '#a855f7' };

  function renderInspector() {
    if (!dom.inspectorBody || !dom.inspectorTitle) return;
    const sel = app.selected;
    if (sel.type === 'camera' || sel.type === 'yaw_kf') {
      dom.inspectorTitle.textContent = '🎥 카메라 · 지평선 · 시점 · 회전 속성';
      dom.inspectorBody.innerHTML = buildCameraInspectorHtml();
    } else if (sel.type === 'target') {
      dom.inspectorTitle.textContent = '🎯 대상 추적 · 거리 · 보정 속성';
      dom.inspectorBody.innerHTML = buildTargetInspectorHtml(sel.id);
    } else if (sel.type === 'fixed' || sel.type === 'scene') {
      dom.inspectorTitle.textContent = '🗺️ 장면 · 경유점 · 고정 음원 · 청취 기준';
      dom.inspectorBody.innerHTML = buildSceneInspectorHtml(sel.type === 'fixed' ? sel.id : null);
    } else if (sel.type === 'source') {
      dom.inspectorTitle.textContent = '🎚️ 음원 분류 · 연결 · 구간 속성';
      dom.inspectorBody.innerHTML = buildSourceInspectorHtml(sel.id);
    } else if (sel.type === 'export') {
      dom.inspectorTitle.textContent = '📦 사전 점검 · 파일 내보내기';
      dom.inspectorBody.innerHTML = buildExportInspectorHtml();
    } else {
      dom.inspectorTitle.textContent = '🔊 출력 장치 · 테스트 톤 · 렌더 설정';
      dom.inspectorBody.innerHTML = buildAudioSetupInspectorHtml();
    }
  }

  function buildAudioSetupInspectorHtml() {
    const st = app.project.studio;
    const route = st.speaker_routing || [0, 1, 2, 3];
    const spkSelect = (idx, label, col) => `
      <div class="prop-box">
        <span style="color:${col};font-weight:700;font-size:11px;">${label}</span>
        <select onchange="StudioApp.setSpeakerRoute(${idx}, this.value)">
          ${[0, 1, 2, 3].map(c => `<option value="${c}" ${route[idx] === c ? 'selected' : ''}>물리 CH ${c + 1}</option>`).join('')}
        </select>
      </div>`;
    return `
      <div class="ins-section">
        <div class="ins-sec-title">1. 영상 및 레퍼런스 열기</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-sm btn-accent" onclick="document.getElementById('fileInputVideo').click()">🎬 영상 파일 열기</button>
          <button class="btn-sm btn-secondary" onclick="document.getElementById('fileInputRefAudio').click()">🎵 별도 레퍼런스 음원</button>
        </div>
        <div class="sub-txt" style="margin-top:5px;">
          현재 영상: <strong>${esc(app.project.video.file || '미지정')}</strong>
          (${app.project.video.width_px}×${app.project.video.height_px} · ${Number(app.project.video.fps).toFixed(2)} fps · ${app.project.video.frames} 프레임)
        </div>
        <div class="prop-grid2" style="margin-top:6px;">
          <label>수동 FPS 지정 (서버 미연결 시)
            <input type="number" step="0.01" min="1" max="240" value="${app.project.video.fps}" onchange="StudioApp.setManualVideoFps(this.value)">
          </label>
          <label>총 프레임 수
            <input type="number" step="1" min="1" value="${app.project.video.frames}" onchange="StudioApp.setManualVideoFrames(this.value)">
          </label>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">2. 출력 장치 · 4채널 스피커 배정 · 테스트 톤</div>
        <label style="font-size:10.5px;color:var(--text-sub);display:block;margin-bottom:6px;">오디오 출력 장치
          <div style="display:flex;gap:4px;margin-top:2px;">
            <select id="audioSinkSelect" style="flex:1;" onchange="StudioApp.setAudioOutputSink(this.value)">
              <option value="">시스템 기본 출력 장치</option>
            </select>
            <button class="btn-xs btn-secondary" onclick="StudioApp.refreshAudioDevices()">장치 새로고침</button>
          </div>
        </label>
        <div class="prop-grid2">
          ${spkSelect(0, 'FL (-30°)', '#3b82f6')}
          ${spkSelect(1, 'FR (+30°)', '#10b981')}
          ${spkSelect(2, 'RL (-135°)', '#f59e0b')}
          ${spkSelect(3, 'RR (+135°)', '#ec4899')}
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;">
          <button class="btn-sm btn-success" onclick="StudioApp.playSpeakerTestTone(-1)">🔄 4채널 순차 테스트</button>
          <button class="btn-sm btn-secondary" onclick="StudioApp.playSpeakerTestTone(0)">FL</button>
          <button class="btn-sm btn-secondary" onclick="StudioApp.playSpeakerTestTone(1)">FR</button>
          <button class="btn-sm btn-secondary" onclick="StudioApp.playSpeakerTestTone(2)">RL</button>
          <button class="btn-sm btn-secondary" onclick="StudioApp.playSpeakerTestTone(3)">RR</button>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">3. 공간 렌더 · 거리 단서 세부 설정</div>
        <label class="prop-row">마스터 볼륨 (${Math.round((st.master_gain ?? 1) * 100)}%)
          <input type="range" min="0" max="200" value="${Math.round((st.master_gain ?? 1) * 100)}" oninput="StudioApp.setStudioParam('master_gain', this.value / 100)">
        </label>
        <label class="prop-row">고도 퍼뜨리기 배율 (${(st.elevation_spread ?? 1).toFixed(2)}x)
          <input type="range" min="0" max="2" step="0.05" value="${st.elevation_spread ?? 1}" oninput="StudioApp.setStudioParam('elevation_spread', Number(this.value))">
        </label>
        <label class="prop-row">전후 스피커 밸런스 (${(st.front_back_bias_db ?? 0).toFixed(1)} dB)
          <input type="range" min="-6" max="6" step="0.5" value="${st.front_back_bias_db ?? 0}" oninput="StudioApp.setStudioParam('front_back_bias_db', Number(this.value))">
        </label>
        <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px;font-size:11px;">
          <label><input type="checkbox" ${st.air_absorption !== false ? 'checked' : ''} onchange="StudioApp.setStudioParam('air_absorption', this.checked)"> 거리별 고역 공기 흡음 (Low-pass)</label>
          <label><input type="checkbox" ${st.reverb_enabled !== false ? 'checked' : ''} onchange="StudioApp.setStudioParam('reverb_enabled', this.checked)"> 거리별 공간 잔향 (Reverb Send)</label>
          <label><input type="checkbox" ${st.doppler_enabled ? 'checked' : ''} onchange="StudioApp.setStudioParam('doppler_enabled', this.checked)"> 상대속도 도플러 피치 변화</label>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">4. 1회차 동선 프리셋 빠른 불러오기</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <button class="btn-xs btn-secondary" onclick="StudioApp.loadBuiltinPreset('path_1', '원형회전')">동선 1: 원형 회전</button>
          <button class="btn-xs btn-secondary" onclick="StudioApp.loadBuiltinPreset('path_2', '360공전')">동선 2: 360° 공전</button>
          <button class="btn-xs btn-secondary" onclick="StudioApp.loadBuiltinPreset('path_3', '헬기비행')">동선 3: 머리 위 헬기</button>
          <button class="btn-xs btn-secondary" onclick="StudioApp.loadBuiltinPreset('path_4', '원거리직선')">동선 4: 원거리 직선</button>
        </div>
      </div>
    `;
  }

  function buildCameraInspectorHtml() {
    const cam = app.project.camera;
    const hz = cam.horizon;
    const curHz = app.scene ? app.scene.horizons[app.currentFrame] : { yPx: 360, pitchDeg: 0 };
    const curYaw = app.scene ? app.scene.yawSeries[app.currentFrame] : 0;
    const curH = app.scene ? app.scene.camHeights[app.currentFrame] : 1.6;
    const targetOpts = `<option value="">(지정 안 함)</option>` +
      app.project.targets.map(t => `<option value="${esc(t.id)}" ${cam.me_target === t.id ? 'selected' : ''}>${esc(t.id)}</option>`).join('');
    const personTargetOpts = `<option value="">('나' 대상 사용)</option>` +
      app.project.targets.map(t => `<option value="${esc(t.id)}" ${cam.height.height_person_target === t.id ? 'selected' : ''}>${esc(t.id)}</option>`).join('');

    return `
      <div class="ins-section">
        <div class="ins-sec-title">영상 클릭 도구 선택</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          ${[
            ['horizon_2pt', '📏 지평선 두 점'],
            ['parallel_4pt', '🛤️ 평행선 4점(소실점)'],
            ['person_2pt', '🧍 사람 발·머리'],
            ['none', '🎯 방향만 확인']
          ].map(([k, lbl]) => `<button class="btn-xs ${app.camClickTool === k ? 'btn-accent' : 'btn-secondary'}" onclick="StudioApp.setCamClickTool('${k}')">${lbl}</button>`).join('')}
        </div>
        ${app.camClickBuffer.length ? `<div class="sub-txt" style="color:#38bdf8;margin-top:4px;">클릭 입력 중: ${app.camClickBuffer.length}점 찍힘 (계속 영상을 클릭하세요)</div>` : ''}
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">1. 지평선 · Pitch (현재 f${app.currentFrame}: Y=${curHz.yPx.toFixed(1)}px, Pitch=${curHz.pitchDeg >= 0 ? '+' : ''}${curHz.pitchDeg.toFixed(1)}°)</div>
        <div class="prop-grid2">
          <label>지평선 계산 방식
            <select onchange="StudioApp.updateHorizonMethod(this.value)">
              <option value="auto" ${hz.method === 'auto' ? 'selected' : ''}>auto (자동 검출)</option>
              <option value="click" ${hz.method === 'click' ? 'selected' : ''}>click (두 점 클릭 보정)</option>
              <option value="parallel_lines" ${hz.method === 'parallel_lines' ? 'selected' : ''}>parallel_lines (소실점)</option>
              <option value="known_person" ${hz.method === 'known_person' ? 'selected' : ''}>known_person (사람 키)</option>
              <option value="pitch_input" ${hz.method === 'pitch_input' ? 'selected' : ''}>pitch_input (직접 입력)</option>
            </select>
          </label>
          <label>Pitch 직접 입력 (°)
            <input type="number" step="0.5" value="${hz.pitch_input_deg ?? 0}" onchange="StudioApp.updatePitchInput(this.value)">
          </label>
        </div>
        <div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;">
          <button class="btn-xs btn-accent" onclick="StudioApp.runAutoHorizonDetection()">🔍 현재 영상 지평선 자동 검출</button>
          <button class="btn-xs btn-secondary" onclick="StudioApp.clearHorizonCorrections()">보정점 초기화 (${hz.corrections.length}개)</button>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">2. '나' 지정 및 시점 구간 (1인칭 / 전환 / 3인칭)</div>
        <div class="prop-grid2">
          <label>'나' 대상 (me_target)
            <select onchange="StudioApp.setMeTarget(this.value)">${targetOpts}</select>
          </label>
          <div style="display:flex;align-items:flex-end;">
            <button class="btn-xs btn-accent" style="width:100%;padding:6px;" onclick="StudioApp.autoJudgeViewSegments()">⚡ 시점 자동 판정</button>
          </div>
        </div>
        <div style="margin-top:6px;max-height:110px;overflow-y:auto;">
          ${cam.view_segments.map((seg, i) => `
            <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:4px;margin-bottom:4px;align-items:center;">
              <select onchange="StudioApp.updateViewSeg(${i}, 'view', this.value)">
                <option value="first_person" ${seg.view === 'first_person' ? 'selected' : ''}>1인칭</option>
                <option value="transition" ${seg.view === 'transition' ? 'selected' : ''}>전환</option>
                <option value="third_person" ${seg.view === 'third_person' ? 'selected' : ''}>3인칭</option>
              </select>
              <input type="number" min="1" max="${app.project.video.frames}" value="${seg.start_frame}" onchange="StudioApp.updateViewSeg(${i}, 'start_frame', this.value)">
              <input type="number" min="1" max="${app.project.video.frames}" value="${seg.end_frame}" onchange="StudioApp.updateViewSeg(${i}, 'end_frame', this.value)">
              <button class="btn-icon" onclick="StudioApp.deleteViewSeg(${i})">✕</button>
            </div>
          `).join('')}
        </div>
        <button class="btn-xs btn-secondary" style="width:100%;" onclick="StudioApp.splitViewSegAtCurrent()">+ 현재 프레임(f${app.currentFrame})에서 시점 구간 분할</button>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">3. 카메라 높이 (현재 f${app.currentFrame}: ${curH.toFixed(2)} m)</div>
        <div class="prop-grid2">
          <label>3인칭 높이 방법
            <select onchange="StudioApp.updateCamHeight('third_person_method', this.value)">
              <option value="from_person" ${cam.height.third_person_method === 'from_person' ? 'selected' : ''}>사람 키로 자동 계산</option>
              <option value="input" ${cam.height.third_person_method === 'input' ? 'selected' : ''}>직접 입력</option>
            </select>
          </label>
          <label>3인칭 높이 입력 (m)
            <input type="number" step="0.1" min="0.3" value="${cam.height.third_person_input_m ?? 2.5}" onchange="StudioApp.updateCamHeight('third_person_input_m', this.value)">
          </label>
          <label style="grid-column:1 / -1;">키 계산 기준 사람 대상
            <select onchange="StudioApp.updateCamHeight('height_person_target', this.value)">${personTargetOpts}</select>
          </label>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">4. 수평 회전 키프레임 (현재 Yaw: ${curYaw >= 0 ? '+' : ''}${curYaw.toFixed(1)}°)</div>
        <div class="sub-txt" style="margin-bottom:6px;">타임라인 [수평 회전] 줄에서 마우스로 구간을 끌어서 바로 만들 수도 있습니다.</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
          <button class="btn-xs btn-accent" onclick="StudioApp.addYawKeyframeAtCurrent(-90)">↺ -90° 추가</button>
          <button class="btn-xs btn-accent" onclick="StudioApp.addYawKeyframeAtCurrent(90)">↻ +90° 추가</button>
          <button class="btn-xs btn-accent" onclick="StudioApp.addYawKeyframeAtCurrent(180)">↻ +180° 추가</button>
          <button class="btn-xs btn-accent" onclick="StudioApp.addYawKeyframeAtCurrent(-180)">↺ -180° 추가</button>
        </div>
        <div style="max-height:130px;overflow-y:auto;">
          ${cam.yaw_keyframes.length === 0 ? '<div class="empty-hint">회전 키프레임 없음 (고정 정면 0°)</div>' :
            cam.yaw_keyframes.map((kf, i) => `
              <div class="yaw-kf-card ${app.selected.type === 'yaw_kf' && app.selected.id === i ? 'selected' : ''}">
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:4px;align-items:center;">
                  <input type="number" title="시작 프레임" value="${kf.start_frame}" onchange="StudioApp.updateYawKf(${i}, 'start_frame', this.value)">
                  <input type="number" title="끝 프레임" value="${kf.end_frame}" onchange="StudioApp.updateYawKf(${i}, 'end_frame', this.value)">
                  <input type="number" step="5" title="누적 목표 각도(°)" value="${kf.to_deg}" onchange="StudioApp.updateYawKf(${i}, 'to_deg', this.value)">
                  <select onchange="StudioApp.updateYawKf(${i}, 'interp', this.value)">
                    <option value="ease" ${kf.interp === 'ease' ? 'selected' : ''}>가감속</option>
                    <option value="linear" ${kf.interp === 'linear' ? 'selected' : ''}>선형</option>
                  </select>
                  <button class="btn-icon" onclick="StudioApp.deleteYawKf(${i})">✕</button>
                </div>
              </div>`).join('')}
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">5. 카메라 3D 위치 키프레임 (${(cam.pos_keyframes || []).length}개)</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn-xs btn-secondary" onclick="StudioApp.addCameraPosKeyframe()">+ 현재 프레임 위치 키프레임</button>
          ${(cam.pos_keyframes || []).length ? `<button class="btn-xs btn-secondary" onclick="StudioApp.clearCameraPosKeyframes()">초기화</button>` : ''}
        </div>
      </div>
    `;
  }

  function buildTargetInspectorHtml(targetId) {
    const t = app.project.targets.find(x => x.id === targetId);
    if (!t) {
      return `<div class="ins-section">
        <div class="empty-hint">선택된 대상이 없습니다.</div>
        <button class="btn-sm btn-accent" style="width:100%;margin-top:8px;" onclick="StudioApp.addTarget()">+ 새 대상 추가</button>
      </div>`;
    }
    const tr = app.scene && app.scene.targetTracks[t.id];
    const curFr = tr ? tr.frames[app.currentFrame] : null;
    const knownKeys = Object.keys(app.project.oral_values.known_sizes_m || {});
    const sizeOpts = `<option value="">(설정값의 대상 크기 선택)</option>` +
      knownKeys.map(k => `<option value="${esc(k)}" ${t.size_key === k ? 'selected' : ''}>${esc(k)} (${app.project.oral_values.known_sizes_m[k]}m)</option>`).join('');

    const uncList = tr && tr.uncertainSpans.length
      ? tr.uncertainSpans.map((sp, i) => `
        <div class="unc-item" onclick="StudioApp.seekToFrame(${sp.start_frame})">
          <span>⚠️ f${sp.start_frame}~${sp.end_frame} (${esc(sp.reason)})</span>
          <div style="display:flex;gap:3px;margin-top:4px;" onclick="event.stopPropagation()">
            <button class="btn-xs btn-accent" onclick="StudioApp.overrideUncertainWithKeyframe('${escJs(t.id)}', ${sp.start_frame}, ${sp.end_frame})">키프레임 덮어쓰기</button>
            <button class="btn-xs btn-success" onclick="StudioApp.retrackFromUncertain('${escJs(t.id)}', ${sp.start_frame})">다시 클릭해 추적</button>
            <button class="btn-xs btn-secondary" onclick="StudioApp.ignoreUncertainSpan('${escJs(t.id)}', ${sp.start_frame}, ${sp.end_frame})">무시</button>
          </div>
        </div>`).join('')
      : '<div class="sub-txt" style="color:#34d399;">검출된 불확실 구간이 없습니다.</div>';

    return `
      <div class="ins-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="ins-sec-title" style="margin:0;">기본 정보</span>
          <button class="btn-xs btn-danger" onclick="StudioApp.deleteTarget('${escJs(t.id)}')">대상 삭제</button>
        </div>
        <div class="prop-grid2">
          <label>대상 ID (영문 권장)
            <input type="text" value="${esc(t.id)}" onchange="StudioApp.renameTarget('${escJs(t.id)}', this.value)">
          </label>
          <label>종류 (기준점 자동)
            <select onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'kind', this.value)">
              <option value="air" ${t.kind === 'air' ? 'selected' : ''}>공중 (air)</option>
              <option value="ground" ${t.kind === 'ground' ? 'selected' : ''}>땅 위 (ground)</option>
            </select>
          </label>
          <label>기준점 위치
            <select onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'ref_point', this.value)">
              <option value="bbox_center" ${t.ref_point === 'bbox_center' ? 'selected' : ''}>박스 중심</option>
              <option value="bbox_bottom_center" ${t.ref_point === 'bbox_bottom_center' ? 'selected' : ''}>박스 하단 중앙(접점)</option>
            </select>
          </label>
          <label>추적 방식
            <select onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'track_tool', this.value)">
              <option value="sam2" ${t.track_tool === 'sam2' ? 'selected' : ''}>SAM 2 자동 추적</option>
              <option value="keyframe" ${t.track_tool === 'keyframe' ? 'selected' : ''}>수동 키프레임 동선</option>
            </select>
          </label>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">SAM 2 클릭 선택 및 양방향 추적</div>
        <div class="prop-grid2">
          <label>추적 해상도(가로 px)
            <select onchange="StudioApp.setSamPrepOption('prepWidth', Number(this.value))">
              ${[480, 640, 960, 1280].map(w => `<option value="${w}" ${app.server.prepWidth === w ? 'selected' : ''}>${w} px</option>`).join('')}
            </select>
          </label>
          <label>추적 간격 (stride)
            <select onchange="StudioApp.setSamPrepOption('prepStride', Number(this.value))">
              ${[1, 2, 3, 5].map(s => `<option value="${s}" ${app.server.prepStride === s ? 'selected' : ''}>${s} 프레임마다</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;">
          <button class="btn-xs btn-secondary" onclick="StudioApp.connectAndPrepareSam2()">1. 서버 연결·추적 준비</button>
          <button class="btn-xs btn-accent" onclick="StudioApp.startSam2TargetTrack('${escJs(t.id)}', 'full')">2. 양방향 전체 추적</button>
          <button class="btn-xs btn-success" onclick="StudioApp.startSam2TargetTrack('${escJs(t.id)}', 'from')">현재 프레임부터 이어 추적</button>
        </div>
        <div class="sub-txt" style="margin-top:5px;">
          영상 <strong>좌클릭=포함(+)</strong>, <strong>우클릭=제외(-)</strong> · 등록된 클릭 ${(t.prompts || []).length}개 · 수동 키프레임 ${(t.manual_keyframes || []).length}개
          ${(t.manual_keyframes || []).length ? `<button class="btn-xs btn-secondary" style="margin-left:4px;" onclick="StudioApp.clearTargetManualKeyframes('${escJs(t.id)}')">덮어쓰기 되돌리기</button>` : ''}
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">불확실 구간 확인 · 보정</div>
        <div style="max-height:130px;overflow-y:auto;">${uncList}</div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">거리 계산 · 가장자리 제외 · 평활화</div>
        <div class="prop-grid2">
          <label>거리 계산 방법
            <select onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'distance_method', this.value)">
              <option value="known_size" ${t.distance_method === 'known_size' ? 'selected' : ''}>기준 크기법 (known_size)</option>
              <option value="ground_contact" ${t.distance_method === 'ground_contact' ? 'selected' : ''}>지면 접점법 (ground_contact)</option>
            </select>
          </label>
          ${t.distance_method === 'known_size' ? `
          <label>측정 축 (size_axis)
            <select onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'size_axis', this.value)">
              <option value="max" ${t.size_axis === 'max' ? 'selected' : ''}>긴 쪽 (max)</option>
              <option value="width" ${t.size_axis === 'width' ? 'selected' : ''}>가로 (width)</option>
              <option value="height" ${t.size_axis === 'height' ? 'selected' : ''}>세로 (height)</option>
            </select>
          </label>
          <label style="grid-column:1 / -1;">적용할 대상 크기 (설정값 연동)
            <select onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'size_key', this.value)">${sizeOpts}</select>
          </label>` : `
          <label>대상 소리 높이 (m)
            <input type="number" step="0.1" value="${t.sound_height_m ?? app.project.oral_values.sound_height_m ?? 1.2}"
              onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'sound_height_m', Number(this.value))">
          </label>`}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:11px;">
          <label><input type="checkbox" ${t.exclude_edges ? 'checked' : ''} onchange="StudioApp.updateTargetProp('${escJs(t.id)}', 'exclude_edges', this.checked)"> 가장자리(L/T/R/B) 제외</label>
          <label style="display:flex;align-items:center;gap:4px;">평활화 ${t.smooth_window || 0}f
            <input type="range" min="0" max="15" step="1" value="${t.smooth_window || 0}" style="width:70px;"
              oninput="StudioApp.updateTargetProp('${escJs(t.id)}', 'smooth_window', Number(this.value))">
          </label>
        </div>

        <div class="stat-readout-card">
          <div>최근접 거리: <strong>${tr && tr.nearest ? `${tr.nearest.distance_m.toFixed(2)} m (f${tr.nearest.frame})` : '데이터 없음'}</strong></div>
          <div>현재 프레임(f${app.currentFrame}): <strong>${curFr && curFr.active ? `방위각 ${curFr.azimuth_deg.toFixed(1)}° · 고도 ${curFr.elevation_deg.toFixed(1)}° · 거리 ${curFr.distance_m.toFixed(2)}m` : '화면 밖 / 비활성'}</strong></div>
        </div>
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="btn-xs btn-success" style="flex:1;" onclick="StudioApp.downloadSingleTargetCsv('${escJs(t.id)}')">💾 이 대상 동선 CSV 저장</button>
          <button class="btn-xs btn-secondary" onclick="StudioApp.createSourceFromTarget('${escJs(t.id)}')">🔊 바로 음원 연결</button>
        </div>
      </div>
    `;
  }

  function buildSceneInspectorHtml(fixedId) {
    const p = app.project;
    const fx = fixedId ? p.fixed_sources.find(x => x.id === fixedId) : p.fixed_sources[0];
    const activeTarget = p.targets.find(t => t.id === app.selected.id) || p.targets[0];

    return `
      <div class="ins-section">
        <div class="ins-sec-title">1. 청취 기준 (Listener Reference)</div>
        <div class="prop-grid2">
          <label>청취 기준 위치
            <select onchange="StudioApp.updateListenerProp('reference', this.value)">
              <option value="camera" ${p.listener.reference === 'camera' ? 'selected' : ''}>camera (카메라 기준 · 제출용)</option>
              <option value="me" ${p.listener.reference === 'me' ? 'selected' : ''}>me ('나' 기준)</option>
            </select>
          </label>
          <label>'나' 정면 방향 (°)
            <input type="number" step="5" value="${p.listener.me_facing_deg ?? 0}" onchange="StudioApp.updateListenerProp('me_facing_deg', Number(this.value))">
          </label>
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">2. 화면 밖 구간 잇기 · 처음/끝 연장 · 경유점</div>
        ${!activeTarget ? '<div class="empty-hint">먼저 대상을 추가하면 화면 밖 구간과 경유점을 편집할 수 있습니다.</div>' : `
          <div class="sub-txt" style="margin-bottom:5px;">대상 선택:
            <select onchange="StudioApp.selectItem('target', this.value)" style="background:#0f172a;color:#fff;border:1px solid #334155;border-radius:4px;padding:2px 5px;">
              ${p.targets.map(t => `<option value="${esc(t.id)}" ${t.id === activeTarget.id ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}
            </select>
          </div>
          <label style="font-size:11px;display:block;margin-bottom:6px;">
            <input type="checkbox" ${activeTarget.bridge_gaps !== false ? 'checked' : ''} onchange="StudioApp.updateTargetProp('${escJs(activeTarget.id)}', 'bridge_gaps', this.checked)">
            화면 밖 사라진 구간 자동 잇기 (탑뷰·타임라인 점선 표시)
          </label>
          <div class="prop-grid2">
            <label>처음 이전 연장
              <select onchange="StudioApp.updateTargetProp('${escJs(activeTarget.id)}', 'extend_start', this.value)">
                <option value="none" ${activeTarget.extend_start === 'none' ? 'selected' : ''}>안 함 (무음)</option>
                <option value="hold" ${activeTarget.extend_start === 'hold' ? 'selected' : ''}>첫 위치 유지 (hold)</option>
                <option value="linear" ${activeTarget.extend_start === 'linear' ? 'selected' : ''}>속도 연장 (linear)</option>
              </select>
            </label>
            <label>끝 이후 연장
              <select onchange="StudioApp.updateTargetProp('${escJs(activeTarget.id)}', 'extend_end', this.value)">
                <option value="none" ${activeTarget.extend_end === 'none' ? 'selected' : ''}>안 함 (무음)</option>
                <option value="hold" ${activeTarget.extend_end === 'hold' ? 'selected' : ''}>끝 위치 유지 (hold)</option>
                <option value="linear" ${activeTarget.extend_end === 'linear' ? 'selected' : ''}>속도 연장 (linear)</option>
              </select>
            </label>
          </div>
          <div class="sub-txt" style="margin-top:6px;">
            탑뷰에서 <strong>더블클릭</strong>하면 현재 프레임(f${app.currentFrame})에 경유점이 추가되고, <strong>드래그</strong>로 옮기면 동선이 즉시 바뀝니다. (경유점 ${(activeTarget.waypoints || []).length}개)
            ${(activeTarget.waypoints || []).length ? `<button class="btn-xs btn-secondary" onclick="StudioApp.clearWaypoints('${escJs(activeTarget.id)}')">경유점 모두 지우기</button>` : ''}
          </div>
        `}
      </div>

      <div class="ins-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="ins-sec-title" style="margin:0;">3. 고정 음원 편집</span>
          <button class="btn-xs btn-accent" onclick="StudioApp.addFixedSourceManual()">+ 고정 음원 추가</button>
        </div>
        ${!fx ? '<div class="empty-hint">영상의 땅을 클릭하거나 [+ 고정 음원 추가]를 누르세요.</div>' : `
          <div class="prop-grid2">
            <label>위치 ID
              <input type="text" value="${esc(fx.id)}" onchange="StudioApp.renameFixedSource('${escJs(fx.id)}', this.value)">
            </label>
            <div style="display:flex;align-items:flex-end;">
              <button class="btn-xs btn-danger" style="width:100%;padding:5px;" onclick="StudioApp.deleteFixedSource('${escJs(fx.id)}')">고정 음원 삭제</button>
            </div>
            <label>X 좌우 (m)
              <input type="number" step="0.1" value="${fx.scene_xyz_m[0]}" onchange="StudioApp.updateFixedCoord('${escJs(fx.id)}', 0, this.value)">
            </label>
            <label>Y 전후 (m)
              <input type="number" step="0.1" value="${fx.scene_xyz_m[1]}" onchange="StudioApp.updateFixedCoord('${escJs(fx.id)}', 1, this.value)">
            </label>
            <label>Z 높이 (m)
              <input type="number" step="0.1" value="${fx.scene_xyz_m[2]}" onchange="StudioApp.updateFixedCoord('${escJs(fx.id)}', 2, this.value)">
            </label>
            <div style="display:flex;align-items:flex-end;">
              <button class="btn-xs btn-secondary" style="width:100%;padding:5px;" onclick="StudioApp.createSourceFromFixed('${escJs(fx.id)}')">🔊 음원 연결</button>
            </div>
          </div>
        `}
      </div>
    `;
  }

  function buildSourceInspectorHtml(sourceId) {
    const s = app.project.sources.find(x => x.id === sourceId);
    if (!s) {
      return `<div class="ins-section">
        <div class="empty-hint">선택된 음원이 없습니다. 파일을 끌어다 놓거나 아래 단추를 누르세요.</div>
        <button class="btn-sm btn-accent" style="width:100%;margin-top:8px;" onclick="document.getElementById('fileInputAudio').click()">+ 음원 파일 추가</button>
      </div>`;
    }
    const q = s.questions || { diegetic: true, needs_position: true, distance_changes: true };
    const buf = app.audioBuffers.get(s.file);
    const chCount = buf ? buf.numberOfChannels : 1;
    const rec = E.recommendDeliveryFromQuestions(q, chCount);

    const targetOpts = `<option value="">-- 대상 동선 선택 --</option>` +
      app.project.targets.map(t => `<option value="${esc(t.id)}" ${s.link && s.link.target === t.id ? 'selected' : ''}>대상: ${esc(t.id)}</option>`).join('');
    const fixedOpts = `<option value="">-- 고정 음원 위치 선택 --</option>` +
      app.project.fixed_sources.map(fx => `<option value="${esc(fx.id)}" ${s.link && s.link.fixed === fx.id ? 'selected' : ''}>고정: ${esc(fx.id)}</option>`).join('');

    return `
      <div class="ins-section" style="border-color:rgba(56,189,248,0.4);">
        <div class="ins-sec-title">1. 분류 질문 3개 (전달 방식 추천)</div>
        <div style="display:flex;flex-direction:column;gap:5px;font-size:11px;">
          <label><input type="checkbox" ${q.diegetic !== false ? 'checked' : ''} onchange="StudioApp.updateSourceQuestion('${escJs(s.id)}', 'diegetic', this.checked)"> ① 장면 안의 소리인가? (Diegetic)</label>
          <label><input type="checkbox" ${q.needs_position ? 'checked' : ''} onchange="StudioApp.updateSourceQuestion('${escJs(s.id)}', 'needs_position', this.checked)"> ② 화면·공간 위치가 필요한가?</label>
          <label><input type="checkbox" ${q.distance_changes ? 'checked' : ''} onchange="StudioApp.updateSourceQuestion('${escJs(s.id)}', 'distance_changes', this.checked)"> ③ 거리가 변하는가?</label>
        </div>
        <div class="rec-banner">
          <span>💡 추천: <strong>${esc(rec.detail)}</strong></span>
          <button class="btn-xs btn-accent" onclick="StudioApp.applySourceRecommendation('${escJs(s.id)}')">적용</button>
        </div>
        <input type="text" placeholder="판단 이유 메모 (한 줄)" value="${esc(s.note || '')}" style="width:100%;margin-top:5px;"
          onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'note', this.value)">
      </div>

      <div class="ins-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="ins-sec-title" style="margin:0;">2. 음원 정보 · 유형 · 전달 방식</span>
          <div style="display:flex;gap:4px;">
            <button class="btn-xs btn-secondary" title="같은 파일의 다른 구간 추가" onclick="StudioApp.duplicateSource('${escJs(s.id)}')">구간 복제</button>
            <button class="btn-xs btn-danger" onclick="StudioApp.deleteSource('${escJs(s.id)}')">삭제</button>
          </div>
        </div>
        <div class="prop-grid2">
          <label>등록 ID
            <input type="text" value="${esc(s.id)}" onchange="StudioApp.renameSource('${escJs(s.id)}', this.value)">
          </label>
          <label>파일 (${buf ? `${buf.numberOfChannels}ch · ${buf.duration.toFixed(2)}s` : '미연결'})
            <input type="text" value="${esc(s.file)}" readonly title="${esc(s.file)}">
          </label>
          <label>유형 (Type)
            <select onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'type', this.value)">
              <option value="DX" ${s.type === 'DX' ? 'selected' : ''}>DX (대사)</option>
              <option value="FX" ${s.type === 'FX' ? 'selected' : ''}>FX (효과음)</option>
              <option value="MX" ${s.type === 'MX' ? 'selected' : ''}>MX (음악)</option>
            </select>
          </label>
          <label>전달 방식 (Delivery)
            <select onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'delivery', this.value)">
              <option value="Object" ${s.delivery === 'Object' ? 'selected' : ''}>Object (공간 위치)</option>
              <option value="Channel" ${s.delivery === 'Channel' ? 'selected' : ''}>Channel (채널 배정)</option>
              <option value="Scene" ${s.delivery === 'Scene' ? 'selected' : ''}>Scene (FOA AmbiX)</option>
            </select>
          </label>
        </div>

        <div style="margin-top:8px;">
          ${s.delivery === 'Object' ? `
            <div class="prop-grid2">
              <label>추적 대상 동선 연결
                <select onchange="StudioApp.updateSourceLink('${escJs(s.id)}', 'target', this.value)">${targetOpts}</select>
              </label>
              <label>또는 고정 음원 위치
                <select onchange="StudioApp.updateSourceLink('${escJs(s.id)}', 'fixed', this.value)">${fixedOpts}</select>
              </label>
            </div>
            <div style="margin-top:5px;font-size:11px;display:flex;gap:10px;flex-wrap:wrap;">
              <label><input type="checkbox" ${s.distance_cues !== false ? 'checked' : ''} onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'distance_cues', this.checked)"> 거리 단서 적용</label>
              <label><input type="checkbox" ${s.near_rule !== false ? 'checked' : ''} onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'near_rule', this.checked)"> 가까운 대상 기준 적용</label>
            </div>
          ` : s.delivery === 'Channel' ? `
            <label style="font-size:11px;display:block;">Channel 배정 규칙
              <select style="width:100%;margin-top:3px;" onchange="StudioApp.updateSourceLink('${escJs(s.id)}', 'channel_rule', this.value)">
                ${[
                  ['DX_center', 'DX_center (정면 FL+FR 중앙)'],
                  ['FX_front', 'FX_front (전면 스테레오 FL/FR)'],
                  ['MX_quad', 'MX_quad (4채널 음악 확장)'],
                  ['auto', 'auto (입력 채널 순서 유지)'],
                  ['CH1', 'CH1 (FL 단독)'],
                  ['CH2', 'CH2 (FR 단독)'],
                  ['CH3', 'CH3 (RL 단독)'],
                  ['CH4', 'CH4 (RR 단독)']
                ].map(([v, l]) => `<option value="${v}" ${(s.link && s.link.channel_rule) === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </label>
          ` : `
            <div class="sub-txt" style="color:#a855f7;">FOA AmbiX (W, Y, Z, X) 4채널 입력을 청취자 수평 회전 및 회전 슬라이더에 맞춰 실시간 디코딩합니다.</div>
          `}
        </div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">3. 재생 구간 (프레임 1 ~ ${app.project.video.frames})</div>
        <div class="prop-grid2">
          <label>시작 프레임
            <input type="number" min="1" max="${app.project.video.frames}" value="${s.start_frame ?? 1}"
              onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'start_frame', Number(this.value))">
          </label>
          <label>끝 프레임 (비우면 파일 끝)
            <input type="number" min="1" max="${app.project.video.frames}" value="${s.end_frame ?? ''}" placeholder="파일 끝까지"
              onchange="StudioApp.updateSourceProp('${escJs(s.id)}', 'end_frame', this.value === '' ? null : Number(this.value))">
          </label>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;">
          <button class="btn-xs btn-accent" onclick="StudioApp.setSourceStartHere('${escJs(s.id)}')">📍 현재 프레임(f${app.currentFrame})에서 시작</button>
          <button class="btn-xs btn-secondary" onclick="StudioApp.fitSourceEndToBuffer('${escJs(s.id)}')">음원 길이 맞춤</button>
          <button class="btn-xs btn-success" onclick="StudioApp.previewSingleSource('${escJs(s.id)}')">▶ 단독 미리듣기</button>
        </div>
      </div>
    `;
  }

  function buildExportInspectorHtml() {
    const out = app.project.outputs;
    const folder = app.project.studio.export_folder || '홍길동_20260001';
    const warnHtml = app.warnings.length === 0
      ? '<div style="color:#34d399;font-size:11px;padding:6px;">✅ 모든 사전 점검 항목을 통과했습니다.</div>'
      : app.warnings.map((w, i) => `
          <div class="warn-row ${w.level}" onclick="StudioApp.jumpToWarning(${i})">
            <span class="warn-tag">${w.level === 'error' ? '오류' : '주의'} · 모드 ${w.mode}</span>
            <span>${esc(w.message)}</span>
          </div>`).join('');

    return `
      <div class="ins-section">
        <div class="ins-sec-title">1. 사전 점검 경고 목록 (${app.warnings.length}건)</div>
        <div style="max-height:150px;overflow-y:auto;">${warnHtml}</div>
      </div>

      <div class="ins-section">
        <div class="ins-sec-title">2. 내보낼 항목 및 제출 이름_학번</div>
        <label style="font-size:11px;display:block;margin-bottom:6px;">저장 폴더 · ZIP 압축 이름 (이름_학번)
          <input type="text" value="${esc(folder)}" style="width:100%;margin-top:3px;"
            onchange="StudioApp.setStudioParam('export_folder', this.value)">
        </label>
        <div style="display:flex;flex-direction:column;gap:5px;font-size:11px;">
          <label><input type="checkbox" id="chkExpWav" checked> 4채널 마스터 WAV (<code>${esc(out.wav_4ch || 'mix_4ch.wav')}</code>)</label>
          <label><input type="checkbox" id="chkExpMp4" ${app.server.connected && app.server.ffmpeg ? 'checked' : ''}> 영상 합성 MP4 (<code>${esc(out.video_mp4 || 'mix_video.mp4')}</code> · 로컬 서버 ffmpeg)</label>
          <label><input type="checkbox" id="chkExpJson" checked> 설정 JSON (<code>settings_${esc((app.project.video.file || 'project').replace(/\.[^.]+$/, ''))}.json</code>)</label>
          <label><input type="checkbox" id="chkExpPaths" checked> 대상별 동선 CSV (${app.project.targets.length}개)</label>
          <label><input type="checkbox" id="chkExpGainLog" checked> 프레임별 게인 로그 (<code>gain_log.csv</code>)</label>
        </div>
        <button class="btn-sm btn-success" style="width:100%;margin-top:10px;padding:9px;font-size:12px;" onclick="StudioApp.runFullExport()">
          📦 선택 항목 내보내기 ${app.server.connected ? '& 이름_학번.zip 다운로드' : '(브라우저 다운로드)'}
        </button>
      </div>
    `;
  }

  // ===========================================================================
  // 7. 실시간 Web Audio 믹서 + 오프라인 4채널 마스터 렌더러
  // ===========================================================================
  function ensureAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx({ sampleRate: SAMPLE_RATE });
      decodeBuiltinSounds();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    rebuildMasterAudioBus();
  }

  function createImpulseResponse(ctx, durationSec, decay) {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const impulse = ctx.createBuffer(4, length, ctx.sampleRate);
    for (let ch = 0; ch < 4; ch++) {
      const data = impulse.getChannelData(ch);
      let seed = 1337 + ch * 9973;
      for (let i = 0; i < length; i++) {
        seed = (seed * 16807) % 2147483647;
        const white = (seed / 1073741823.5) - 1.0;
        data[i] = white * Math.pow(1 - i / length, decay) * 0.35;
      }
    }
    return impulse;
  }

  function rebuildMasterAudioBus() {
    if (!audioCtx) return;
    if (masterGainNode) {
      try { masterGainNode.disconnect(); } catch (_) {}
    }
    const outMode = app.project.studio.output_mode || 'downmix';
    const maxCh = audioCtx.destination.maxChannelCount || 2;
    if (outMode === 'multichannel' && maxCh >= 4) {
      audioCtx.destination.channelCount = 4;
      audioCtx.destination.channelCountMode = 'explicit';
      audioCtx.destination.channelInterpretation = 'discrete';
    } else {
      audioCtx.destination.channelCount = 2;
      audioCtx.destination.channelCountMode = 'explicit';
      audioCtx.destination.channelInterpretation = 'speakers';
    }

    masterGainNode = audioCtx.createGain();
    masterGainNode.gain.value = app.listenRefMode ? 0.0 : (app.project.studio.master_gain ?? 1.0);

    for (let i = 0; i < 4; i++) {
      speakerBusGains[i] = audioCtx.createGain();
      speakerAnalysers[i] = audioCtx.createAnalyser();
      speakerAnalysers[i].fftSize = 256;
      speakerBusGains[i].connect(speakerAnalysers[i]);
    }

    reverbConvolver = audioCtx.createConvolver();
    reverbConvolver.buffer = createImpulseResponse(audioCtx, 1.1, 2.8);
    reverbWetBus = audioCtx.createGain();
    reverbWetBus.gain.value = app.project.studio.reverb_enabled !== false ? 0.35 : 0.0;
    reverbWetBus.connect(reverbConvolver);
    const revSplit = audioCtx.createChannelSplitter(4);
    reverbConvolver.connect(revSplit);
    for (let i = 0; i < 4; i++) revSplit.connect(speakerBusGains[i], i, 0);

    const route = app.project.studio.speaker_routing || [0, 1, 2, 3];
    if (outMode === 'multichannel' && maxCh >= 4) {
      const merger = audioCtx.createChannelMerger(4);
      for (let i = 0; i < 4; i++) {
        speakerAnalysers[i].connect(merger, 0, E.clamp(route[i], 0, 3));
      }
      merger.connect(masterGainNode);
    } else {
      // 이어폰 스테레오 다운믹스 (전후 구분을 위해 후면 -3dB 적용)
      const merger = audioCtx.createChannelMerger(2);
      const rlAtt = audioCtx.createGain(); rlAtt.gain.value = 0.707;
      const rrAtt = audioCtx.createGain(); rrAtt.gain.value = 0.707;
      speakerAnalysers[0].connect(merger, 0, 0);
      speakerAnalysers[1].connect(merger, 0, 1);
      speakerAnalysers[2].connect(rlAtt); rlAtt.connect(merger, 0, 0);
      speakerAnalysers[3].connect(rrAtt); rrAtt.connect(merger, 0, 1);
      merger.connect(masterGainNode);
    }
    masterGainNode.connect(audioCtx.destination);
  }

  function decodeBuiltinSounds() {
    if (!audioCtx) return;
    const decodeB64 = (b64, cb) => {
      if (!b64) return;
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        audioCtx.decodeAudioData(bytes.buffer.slice(0)).then(cb).catch(() => {});
      } catch (_) {}
    };
    decodeB64(window.DEFAULT_MOVING_SOUND_WAV_BASE64, buf => {
      builtinMovingBuf = buf;
      app.audioBuffers.set('Moving_sound.wav', buf);
    });
    decodeB64(window.DEFAULT_CHANNEL_TEST_WAV_BASE64, buf => {
      builtinChannelBuf = buf;
      app.audioBuffers.set('channel_test.wav', buf);
    });
  }

  function playSpeakerTestTone(chIndex) {
    stopTransport();
    ensureAudioContext();
    app.project.studio.checklist_done.m1_audio = true;
    renderChecklist();
    updateTopBarUI();

    const playOne = (idx, delaySec) => {
      const osc = audioCtx.createOscillator();
      const env = audioCtx.createGain();
      osc.frequency.value = [440, 554.37, 329.63, 659.25][idx];
      const t0 = audioCtx.currentTime + delaySec;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(0.55, t0 + 0.04);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);
      osc.connect(env);
      env.connect(speakerBusGains[idx]);
      osc.start(t0);
      osc.stop(t0 + 0.7);
    };
    if (chIndex < 0) {
      for (let i = 0; i < 4; i++) playOne(i, i * 0.75);
      setStatusMessage('4채널 순차 테스트 톤 출력 중 (FL → FR → RL → RR)');
    } else {
      playOne(chIndex, 0);
      setStatusMessage(`${E.SPEAKER_IDS[chIndex]} 테스트 톤 출력`);
    }
    startMeterLoop();
  }

  function startTransport() {
    ensureAudioContext();
    stopLiveAudioNodes();

    const fps = app.scene.fps;
    const totalDur = app.scene.totalFrames / fps;
    let startSec = (app.currentFrame - 1) / fps;
    if (startSec >= totalDur - 0.02) {
      app.currentFrame = app.loopRange.enabled ? app.loopRange.start : 1;
      startSec = (app.currentFrame - 1) / fps;
    }

    playStartCtxTime = audioCtx.currentTime;
    playStartSec = startSec;
    isPlaying = true;

    // 비디오 동기화 재생 (비디오 원음은 listenRefMode이고 별도 refAudioBuffer가 없을 때만 켬)
    if (dom.vVideo && dom.vVideo.src && dom.vVideo.readyState >= 1) {
      dom.vVideo.muted = !(app.listenRefMode && !app.refAudioBuffer);
      dom.vVideo.currentTime = startSec;
      dom.vVideo.play().catch(() => {});
    }

    // 별도 레퍼런스 오디오 버퍼 동기화
    if (app.refAudioBuffer && startSec < app.refAudioBuffer.duration) {
      liveRefNode = audioCtx.createBufferSource();
      liveRefNode.buffer = app.refAudioBuffer;
      liveRefGain = audioCtx.createGain();
      liveRefGain.gain.value = app.listenRefMode ? 1.0 : 0.0;
      liveRefNode.connect(liveRefGain);
      liveRefGain.connect(audioCtx.destination);
      liveRefNode.start(0, startSec);
    }

    // 등록된 각 음원을 실시간 공간 오디오 노드로 스케줄링 (재생 중 볼륨/M/S/회전 즉시 반영!)
    for (const s of app.project.sources) {
      const buf = app.audioBuffers.get(s.file);
      if (!buf) continue;
      const trackStartSec = ((s.start_frame || 1) - 1) / fps;
      const trackEndSec = s.end_frame ? (s.end_frame / fps) : Math.min(totalDur, trackStartSec + buf.duration);
      if (trackEndSec <= startSec) continue;

      const node = audioCtx.createBufferSource();
      node.buffer = buf;
      const trimGain = audioCtx.createGain();
      const lpf = audioCtx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 20000;

      const spkGains = [0, 1, 2, 3].map(() => audioCtx.createGain());
      const revSend = audioCtx.createGain();
      revSend.gain.value = 0;

      let foaMatrixGains = null;
      if (s.delivery === 'Scene') {
        const splitter = audioCtx.createChannelSplitter(Math.max(4, buf.numberOfChannels));
        node.connect(trimGain);
        trimGain.connect(splitter);
        foaMatrixGains = [0, 1, 2, 3].map(spkIdx => {
          return [0, 1, 2, 3].map(chIdx => {
            const g = audioCtx.createGain();
            g.gain.value = 0;
            if (chIdx < buf.numberOfChannels) splitter.connect(g, chIdx, 0);
            g.connect(speakerBusGains[spkIdx]);
            return g;
          });
        });
      } else if (s.delivery === 'Channel') {
        const chs = buf.numberOfChannels;
        const splitter = audioCtx.createChannelSplitter(chs);
        node.connect(trimGain);
        trimGain.connect(splitter);
        const mat = E.computeChannelRuleGains((s.link && s.link.channel_rule) || 'auto', chs);
        for (let c = 0; c < chs; c++) {
          for (let spk = 0; spk < 4; spk++) {
            if (mat[c][spk] > 0) {
              const g = audioCtx.createGain();
              g.gain.value = mat[c][spk];
              splitter.connect(g, c, 0);
              g.connect(speakerBusGains[spk]);
            }
          }
        }
      } else {
        // Object: 모노 합산 -> LPF -> 4개 스피커 게인 + 잔향 센드
        node.connect(trimGain);
        trimGain.connect(lpf);
        spkGains.forEach((g, idx) => {
          g.gain.value = 0;
          lpf.connect(g);
          g.connect(speakerBusGains[idx]);
        });
        lpf.connect(revSend);
        revSend.connect(reverbWetBus);
      }

      const when = Math.max(0, trackStartSec - startSec);
      const offset = Math.max(0, startSec - trackStartSec);
      const dur = Math.max(0.01, Math.min(buf.duration - offset, trackEndSec - Math.max(startSec, trackStartSec)));
      if (offset < buf.duration && dur > 0) {
        node.start(audioCtx.currentTime + when, offset, dur);
        liveNodes.push({ source: s, node, trimGain, lpf, spkGains, revSend, foaMatrixGains });
      }
    }

    updateLiveAudioParamsAtFrame(app.currentFrame);
    dom.btnPlayPause.textContent = '⏸ 정지';
    startMeterLoop();
  }

  function stopLiveAudioNodes() {
    liveNodes.forEach(item => {
      try { item.node.stop(); } catch (_) {}
      try { item.node.disconnect(); } catch (_) {}
    });
    liveNodes = [];
    if (liveRefNode) {
      try { liveRefNode.stop(); } catch (_) {}
      liveRefNode = null;
      liveRefGain = null;
    }
  }

  function stopTransport() {
    isPlaying = false;
    stopLiveAudioNodes();
    if (dom.vVideo && !dom.vVideo.paused) dom.vVideo.pause();
    if (dom.btnPlayPause) dom.btnPlayPause.textContent = '▶ 재생';
  }

  function togglePlay() {
    if (isPlaying) stopTransport();
    else startTransport();
  }

  function updateLiveAudioParamsAtFrame(frame) {
    if (!audioCtx || !app.scene) return;
    const f = E.clamp(Math.round(frame), 1, app.scene.totalFrames);
    const anySolo = app.project.sources.some(s => s.solo);
    const now = audioCtx.currentTime;

    if (masterGainNode) {
      masterGainNode.gain.setTargetAtTime(app.listenRefMode ? 0.0 : (app.project.studio.master_gain ?? 1.0), now, 0.015);
    }
    if (liveRefGain) {
      liveRefGain.gain.setTargetAtTime(app.listenRefMode ? 1.0 : 0.0, now, 0.015);
    }
    if (dom.vVideo && dom.vVideo.src) {
      dom.vVideo.muted = !(app.listenRefMode && !app.refAudioBuffer);
    }

    for (const item of liveNodes) {
      const s = item.source;
      const audible = !s.muted && (!anySolo || s.solo);
      const linGain = audible ? Math.pow(10, (Number(s.gain_db) || 0) / 20.0) : 0.0;
      item.trimGain.gain.setTargetAtTime(linGain, now, 0.015);

      if (s.delivery === 'Scene' && item.foaMatrixGains) {
        const yaw = app.scene.listenerYaw[f] + app.rotationCheckDeg;
        const mat = E.computeFoaDecodeMatrix(yaw);
        for (let spk = 0; spk < 4; spk++) {
          for (let ch = 0; ch < 4; ch++) {
            item.foaMatrixGains[spk][ch].gain.setTargetAtTime(mat[spk][ch], now, 0.02);
          }
        }
      } else if (s.delivery === 'Object') {
        const fr = resolveObjectFrameState(s, f);
        if (!fr || !fr.active) {
          item.spkGains.forEach(g => g.gain.setTargetAtTime(0, now, 0.02));
          item.revSend.gain.setTargetAtTime(0, now, 0.02);
        } else {
          const g = E.computeObjectSpeakerGains({
            azimuthDeg: fr.azimuth_deg,
            elevationDeg: fr.elevation_deg,
            distanceM: fr.distance_m,
            rotationOffsetDeg: app.rotationCheckDeg,
            elevationScale: app.project.studio.elevation_spread ?? 1.0,
            frontBackBiasDb: app.project.studio.front_back_bias_db ?? 0.0,
            applyDistanceCues: s.distance_cues !== false,
            applyNearRule: s.near_rule !== false,
            nearThresholdM: app.project.oral_values.near_threshold_m ?? 1.5,
            attenRefM: app.project.oral_values.atten_ref_m ?? 2.0,
            attenK: app.project.oral_values.atten_k ?? 1.0,
            trackGainLinear: 1.0
          });
          for (let i = 0; i < 4; i++) item.spkGains[i].gain.setTargetAtTime(g.gains[i], now, 0.02);
          item.lpf.frequency.setTargetAtTime(app.project.studio.air_absorption !== false ? g.lowpassHz : 20000, now, 0.03);
          item.revSend.gain.setTargetAtTime(app.project.studio.reverb_enabled !== false ? g.reverbSend : 0, now, 0.03);

          if (app.project.studio.doppler_enabled && f > 1) {
            const prevFr = resolveObjectFrameState(s, f - 1);
            if (prevFr && prevFr.active) {
              const vr = (fr.distance_m - prevFr.distance_m) * app.scene.fps;
              const rate = E.clamp(E.SPEED_OF_SOUND / (E.SPEED_OF_SOUND + vr), 0.85, 1.15);
              item.node.playbackRate.setTargetAtTime(rate, now, 0.04);
            }
          }
        }
      }
    }
  }

  function resolveObjectFrameState(source, frame) {
    if (source.link && source.link.target && app.scene.targetTracks[source.link.target]) {
      return app.scene.targetTracks[source.link.target].frames[frame];
    }
    if (source.link && source.link.fixed && app.scene.fixedTracks[source.link.fixed]) {
      return app.scene.fixedTracks[source.link.fixed].frames[frame];
    }
    if (source._customPath && source._customPath.length) {
      const idx = E.clamp(frame - 1, 0, source._customPath.length - 1);
      const r = source._customPath[idx];
      return { active: r.visible !== 0, azimuth_deg: r.azimuth_deg, elevation_deg: r.elevation_deg, distance_m: r.distance_m };
    }
    return null;
  }

  /**
   * 오프라인 4채널 마스터 버퍼 렌더링 (클리핑 방지 포함)
   */
  async function renderOfflineMaster() {
    if (!app.project.sources.length) {
      throw new Error('렌더링할 음원이 없습니다. ⑤ 소리에서 음원을 추가하세요.');
    }
    setBgJob(true, '4채널 공간 음향 오프라인 렌더링 중...', 20, false);
    try {
      const fps = app.scene.fps;
      const durationSec = app.scene.totalFrames / fps;
      const totalSamples = Math.max(1, Math.ceil(durationSec * SAMPLE_RATE));
      const offline = new OfflineAudioContext(4, totalSamples, SAMPLE_RATE);
      const merger = offline.createChannelMerger(4);
      merger.connect(offline.destination);

      const anySolo = app.project.sources.some(s => s.solo);
      const route = app.project.studio.speaker_routing || [0, 1, 2, 3];

      for (const s of app.project.sources) {
        const buf = app.audioBuffers.get(s.file);
        if (!buf) throw new Error(`음원 '${s.id}' (${s.file}) 파일이 연결되지 않았습니다.`);
        if (s.muted || (anySolo && !s.solo)) continue;

        const startSec = Math.max(0, ((s.start_frame || 1) - 1) / fps);
        const endSec = s.end_frame ? Math.min(durationSec, s.end_frame / fps) : Math.min(durationSec, startSec + buf.duration);
        const playDur = Math.min(buf.duration, endSec - startSec);
        if (playDur <= 0) continue;

        const trackGain = Math.pow(10, (Number(s.gain_db) || 0) / 20.0);
        const src = offline.createBufferSource();
        src.buffer = buf;

        if (s.delivery === 'Scene') {
          const split = offline.createChannelSplitter(Math.max(4, buf.numberOfChannels));
          src.connect(split);
          const matNodes = [0, 1, 2, 3].map(spk => [0, 1, 2, 3].map(ch => {
            const g = offline.createGain();
            g.gain.setValueAtTime(0, 0);
            if (ch < buf.numberOfChannels) split.connect(g, ch, 0);
            g.connect(merger, 0, E.clamp(route[spk], 0, 3));
            return g;
          }));
          for (let f = 1; f <= app.scene.totalFrames; f++) {
            const t = (f - 1) / fps;
            if (t < startSec - 0.05 || t > endSec + 0.05) continue;
            const mat = E.computeFoaDecodeMatrix(app.scene.listenerYaw[f] + app.rotationCheckDeg);
            for (let spk = 0; spk < 4; spk++) {
              for (let ch = 0; ch < 4; ch++) matNodes[spk][ch].gain.setValueAtTime(mat[spk][ch] * trackGain, t);
            }
          }
        } else if (s.delivery === 'Channel') {
          const chs = buf.numberOfChannels;
          const split = offline.createChannelSplitter(chs);
          src.connect(split);
          const mat = E.computeChannelRuleGains((s.link && s.link.channel_rule) || 'auto', chs);
          for (let c = 0; c < chs; c++) {
            for (let spk = 0; spk < 4; spk++) {
              if (mat[c][spk] > 0) {
                const g = offline.createGain();
                g.gain.value = mat[c][spk] * trackGain;
                split.connect(g, c, 0);
                g.connect(merger, 0, E.clamp(route[spk], 0, 3));
              }
            }
          }
        } else {
          // Object
          const split = offline.createChannelSplitter(buf.numberOfChannels);
          const mono = offline.createGain();
          mono.gain.value = 1 / buf.numberOfChannels;
          src.connect(split);
          for (let c = 0; c < buf.numberOfChannels; c++) split.connect(mono, c, 0);

          const lpf = offline.createBiquadFilter();
          lpf.type = 'lowpass';
          lpf.frequency.setValueAtTime(20000, 0);
          mono.connect(lpf);

          const spkNodes = [0, 1, 2, 3].map(spk => {
            const g = offline.createGain();
            g.gain.setValueAtTime(0, 0);
            lpf.connect(g);
            g.connect(merger, 0, E.clamp(route[spk], 0, 3));
            return g;
          });

          for (let f = 1; f <= app.scene.totalFrames; f++) {
            const t = (f - 1) / fps;
            if (t < startSec - 0.05 || t > endSec + 0.05) continue;
            const fr = resolveObjectFrameState(s, f);
            if (!fr || !fr.active) {
              spkNodes.forEach(g => g.gain.setValueAtTime(0, t));
            } else {
              const calc = E.computeObjectSpeakerGains({
                azimuthDeg: fr.azimuth_deg,
                elevationDeg: fr.elevation_deg,
                distanceM: fr.distance_m,
                rotationOffsetDeg: app.rotationCheckDeg,
                elevationScale: app.project.studio.elevation_spread ?? 1.0,
                frontBackBiasDb: app.project.studio.front_back_bias_db ?? 0.0,
                applyDistanceCues: s.distance_cues !== false,
                applyNearRule: s.near_rule !== false,
                nearThresholdM: app.project.oral_values.near_threshold_m ?? 1.5,
                attenRefM: app.project.oral_values.atten_ref_m ?? 2.0,
                attenK: app.project.oral_values.atten_k ?? 1.0,
                trackGainLinear: trackGain
              });
              for (let i = 0; i < 4; i++) spkNodes[i].gain.setValueAtTime(calc.gains[i], t);
              if (app.project.studio.air_absorption !== false) lpf.frequency.setValueAtTime(calc.lowpassHz, t);
            }
          }
          spkNodes.forEach(g => g.gain.setValueAtTime(0, endSec));
        }

        src.start(startSec, 0, playDur);
      }

      setBgJob(true, '오프라인 오디오 합성 중...', 65, false);
      const rendered = await offline.startRendering();

      let peak = 0;
      const masterVol = app.project.studio.master_gain ?? 1.0;
      for (let c = 0; c < 4; c++) {
        const ch = rendered.getChannelData(c);
        for (let i = 0; i < ch.length; i++) {
          const abs = Math.abs(ch[i]);
          if (abs > peak) peak = abs;
        }
      }
      const peakWithMaster = peak * masterVol;
      const limiter = peakWithMaster > 0.98 ? (0.98 / peakWithMaster) : 1.0;
      const totalScale = masterVol * limiter;
      for (let c = 0; c < 4; c++) {
        const ch = rendered.getChannelData(c);
        for (let i = 0; i < ch.length; i++) ch[i] *= totalScale;
      }

      app.renderedBuffer = rendered;
      app.renderInfo = { peakBeforeLimit: peakWithMaster, limiterGain: limiter, appliedGain: totalScale };
      app.renderDirty = false;
      app.project.studio.checklist_done.m5_mix = true;
      recomputeAll(false);
      setStatusMessage(`렌더 완료 · 합산 피크 ${peakWithMaster.toFixed(3)}${limiter < 1 ? ` (클리핑 방지 ${limiter.toFixed(3)}x 적용)` : ''}`);
      return rendered;
    } catch (err) {
      logError(err.message);
      throw err;
    } finally {
      setBgJob(false);
    }
  }

  function startMeterLoop() {
    if (animFrameId) return;
    const tick = () => {
      animFrameId = null;
      if (isPlaying && audioCtx && app.scene) {
        const elapsed = audioCtx.currentTime - playStartCtxTime;
        const curSec = playStartSec + elapsed;
        const nextFrame = Math.floor(curSec * app.scene.fps) + 1;

        if (app.loopRange.enabled && nextFrame > app.loopRange.end) {
          app.currentFrame = app.loopRange.start;
          startTransport();
          return;
        }
        if (nextFrame > app.scene.totalFrames) {
          app.currentFrame = app.scene.totalFrames;
          stopTransport();
          updateFrameReadout();
          requestViewportRedraw();
          return;
        }
        if (nextFrame !== app.currentFrame) {
          app.currentFrame = nextFrame;
          updateFrameReadout();
          updateLiveAudioParamsAtFrame(app.currentFrame);
          requestSam2MaskIfNeeded();
          requestViewportRedraw();
        }
      }

      // 4채널 미니 레벨 미터 갱신
      const ids = ['FL', 'FR', 'RL', 'RR'];
      const buf = new Uint8Array(128);
      let anyMeterActive = false;
      for (let i = 0; i < 4; i++) {
        const bar = dom[`miniMeter${ids[i]}`];
        if (!bar || !speakerAnalysers[i]) continue;
        speakerAnalysers[i].getByteTimeDomainData(buf);
        let sum = 0;
        for (let j = 0; j < buf.length; j++) {
          const v = (buf[j] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 1e-4 ? 20 * Math.log10(rms) : -70;
        const pct = E.clamp(((db + 50) / 50) * 100, 0, 100);
        bar.style.width = `${pct}%`;
        if (pct > 1) anyMeterActive = true;
      }

      if (isPlaying || anyMeterActive) animFrameId = requestAnimationFrame(tick);
    };
    animFrameId = requestAnimationFrame(tick);
  }

  // ===========================================================================
  // 8. 영상 보기 · 탑뷰 · 공용 타임라인 Canvas 렌더링 및 마우스 조작
  // ===========================================================================
  let redrawPending = false;
  function requestViewportRedraw() {
    if (redrawPending) return;
    redrawPending = true;
    requestAnimationFrame(() => {
      redrawPending = false;
      drawVideoOverlay();
      drawTopView();
      drawSharedTimeline();
      updateHudBar();
    });
  }

  function seekToFrame(frame) {
    if (!app.scene) return;
    const f = E.clamp(Math.round(frame), 1, app.scene.totalFrames);
    app.currentFrame = f;
    if (dom.vVideo && dom.vVideo.readyState >= 1) {
      dom.vVideo.currentTime = (f - 1) / app.scene.fps;
    }
    if (isPlaying) startTransport();
    updateFrameReadout();
    requestSam2MaskIfNeeded();
    requestViewportRedraw();
    if (app.selected.type === 'camera' || app.selected.type === 'target') renderInspector();
  }

  function updateFrameReadout() {
    if (!dom.timeReadout || !app.scene) return;
    const sec = (app.currentFrame - 1) / app.scene.fps;
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = (sec % 60).toFixed(2).padStart(5, '0');
    const loopTxt = app.loopRange.enabled ? ` [구간 ${app.loopRange.start}~${app.loopRange.end}]` : '';
    dom.timeReadout.textContent = `f${app.currentFrame} / ${app.scene.totalFrames} (${mm}:${ss})${loopTxt}`;
  }

  function updateHudBar() {
    if (!app.scene) return;
    const f = app.currentFrame;
    const hz = app.scene.horizons[f];
    const yaw = app.scene.yawSeries[f];
    const ch = app.scene.camHeights[f];
    if (dom.hudCamText) {
      dom.hudCamText.textContent = `카메라 H:${ch.toFixed(2)}m · Pitch:${hz.pitchDeg >= 0 ? '+' : ''}${hz.pitchDeg.toFixed(1)}° · Yaw:${yaw >= 0 ? '+' : ''}${yaw.toFixed(1)}°`;
    }
    if (app.selected.type === 'target' && app.selected.id && app.scene.targetTracks[app.selected.id]) {
      const fr = app.scene.targetTracks[app.selected.id].frames[f];
      if (fr && fr.active) {
        dom.hudDirText.textContent = `[${app.selected.id}] 방위각 ${fr.azimuth_deg >= 0 ? '+' : ''}${fr.azimuth_deg.toFixed(1)}° · 고도 ${fr.elevation_deg >= 0 ? '+' : ''}${fr.elevation_deg.toFixed(1)}°`;
        dom.hudDistText.textContent = `거리 ${fr.distance_m.toFixed(2)}m (${fr.estimated ? '화면 밖 추정' : '화면 안'})`;
        return;
      }
    }
    if (app.clickMarker.active) {
      dom.hudDirText.textContent = `클릭 방향 방위각 ${app.clickMarker.az >= 0 ? '+' : ''}${app.clickMarker.az.toFixed(1)}° · 고도 ${app.clickMarker.el >= 0 ? '+' : ''}${app.clickMarker.el.toFixed(1)}°`;
      dom.hudDistText.textContent = `픽셀 (${Math.round(app.clickMarker.x)}, ${Math.round(app.clickMarker.y)})`;
    } else {
      dom.hudDirText.textContent = '화면을 클릭하면 방향이 표시됩니다';
      dom.hudDistText.textContent = `HFOV ${app.project.video.hfov_deg}°`;
    }
  }

  // video 엘리먼트 object-fit: contain 내부 실제 렌더링 사각형 계산
  function getVideoContentRect(canvas) {
    const cw = canvas.width, ch = canvas.height;
    const vw = app.project.video.width_px || 1280;
    const vh = app.project.video.height_px || 720;
    const scale = Math.min(cw / vw, ch / vh);
    const rw = vw * scale, rh = vh * scale;
    const ox = (cw - rw) / 2.0, oy = (ch - rh) / 2.0;
    return { ox, oy, rw, rh, scale, vw, vh };
  }

  function videoPxToCanvas(vx, vy, r) {
    return [r.ox + vx * r.scale, r.oy + vy * r.scale];
  }

  function canvasToVideoPx(cx, cy, r) {
    return [
      E.clamp((cx - r.ox) / r.scale, 0, r.vw),
      E.clamp((cy - r.oy) / r.scale, 0, r.vh)
    ];
  }

  function drawVideoOverlay() {
    const c = dom.videoCanvas;
    if (!c || !app.scene) return;
    const pw = c.parentElement.clientWidth;
    const ph = c.parentElement.clientHeight;
    if (pw < 10 || ph < 10) return;
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const r = getVideoContentRect(c);
    const f = app.currentFrame;

    // 1) 그리드
    if (app.overlays.grid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(r.ox + r.rw / 2, r.oy); ctx.lineTo(r.ox + r.rw / 2, r.oy + r.rh);
      ctx.moveTo(r.ox, r.oy + r.rh / 2); ctx.lineTo(r.ox + r.rw, r.oy + r.rh / 2);
      ctx.stroke();
      ctx.restore();
    }

    // 2) 지평선
    if (app.overlays.horizon) {
      const hz = app.scene.horizons[f];
      const tanR = Math.tan((hz.rollDeg || 0) * Math.PI / 180);
      const yL = hz.yPx - (r.vw / 2) * tanR;
      const yR = hz.yPx + (r.vw / 2) * tanR;
      const [x1, cy1] = videoPxToCanvas(0, yL, r);
      const [x2, cy2] = videoPxToCanvas(r.vw, yR, r);
      ctx.save();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, cy1);
      ctx.lineTo(x2, cy2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#facc15';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`지평선 (${hz.pitchDeg >= 0 ? '+' : ''}${hz.pitchDeg.toFixed(1)}°)`, x1 + 8, cy1 - 6);
      ctx.restore();
    }

    // 3) SAM 2 마스크 오버레이 (선택 대상)
    if (app.overlays.mask && app.selected.type === 'target' && app.selected.id) {
      const maskCvs = app.server.maskCache.get(`${app.selected.id}:${f}`);
      if (maskCvs) {
        ctx.save();
        ctx.drawImage(maskCvs, r.ox, r.oy, r.rw, r.rh);
        ctx.restore();
      }
    }

    // 4) 대상 궤적 · 바운딩 박스 · 기준점 · '나' 박스 · 화면 밖 방향 화살표
    app.project.targets.forEach((t, idx) => {
      const tr = app.scene.targetTracks[t.id];
      if (!tr) return;
      const isMe = app.project.camera.me_target === t.id;
      const isSelected = app.selected.type === 'target' && app.selected.id === t.id;
      const col = isMe ? '#f43f5e' : TARGET_COLORS[idx % TARGET_COLORS.length];

      // 2D 화면 궤적
      if (app.overlays.trail) {
        ctx.save();
        ctx.strokeStyle = col + (isSelected ? 'dd' : '66');
        ctx.lineWidth = isSelected ? 2.2 : 1.3;
        ctx.beginPath();
        let started = false;
        for (let k = 1; k <= app.scene.totalFrames; k++) {
          const ob = tr.obs[k];
          if (ob && ob.visible && ob.x_px !== null) {
            const [cx, cy] = videoPxToCanvas(ob.x_px, ob.y_px, r);
            if (!started) { ctx.moveTo(cx, cy); started = true; }
            else ctx.lineTo(cx, cy);
          } else {
            started = false;
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      const ob = tr.obs[f];
      const fr = tr.frames[f];
      if (ob && ob.visible && ob.x_px !== null) {
        if ((app.overlays.box && !isMe) || (app.overlays.meBox && isMe)) {
          if (ob.bbox_x !== null && ob.bbox_w) {
            const [bx, by] = videoPxToCanvas(ob.bbox_x, ob.bbox_y, r);
            ctx.save();
            ctx.strokeStyle = ob.uncertain ? '#fbbf24' : col;
            ctx.lineWidth = isSelected || isMe ? 2.5 : 1.6;
            ctx.strokeRect(bx, by, ob.bbox_w * r.scale, ob.bbox_h * r.scale);
            ctx.fillStyle = ob.uncertain ? '#fbbf24' : col;
            ctx.font = 'bold 11px sans-serif';
            const lbl = `${isMe ? "[나] " : ""}${t.id}${fr ? ` (${fr.distance_m.toFixed(1)}m)` : ''}`;
            ctx.fillText(lbl, bx, Math.max(r.oy + 12, by - 5));
            ctx.restore();
          }
        }
        if (app.overlays.refPoint) {
          const [px, py] = videoPxToCanvas(ob.x_px, ob.y_px, r);
          ctx.save();
          ctx.fillStyle = col;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      } else if (fr && fr.active && fr.estimated) {
        // 화면 밖 추정 구간일 때: 탑뷰에서 경유점을 끌면 영상 가장자리에도 방향 표시기가 즉시 반응!
        const intr = app.scene.intrinsics;
        const camYaw = app.scene.yawSeries[f];
        const worldAz = Math.atan2(fr.scene_xyz[0] - app.scene.camPos[f][0], fr.scene_xyz[1] - app.scene.camPos[f][1]) * 180 / Math.PI;
        const camRelAz = E.wrapDeg(worldAz - camYaw);
        const projX = E.clamp(intr.width / 2 + intr.focalPx * Math.tan(E.clamp(camRelAz, -80, 80) * Math.PI / 180), 16, intr.width - 16);
        const [ix, iy] = videoPxToCanvas(projX, intr.height / 2, r);
        const edgeX = camRelAz < -intr.hfovDeg / 2 ? r.ox + 18 : (camRelAz > intr.hfovDeg / 2 ? r.ox + r.rw - 18 : ix);
        ctx.save();
        ctx.fillStyle = '#2dd4bf';
        ctx.font = 'bold 11px sans-serif';
        ctx.beginPath();
        ctx.arc(edgeX, iy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(`⇄ ${t.id} (${camRelAz >= 0 ? '+' : ''}${camRelAz.toFixed(0)}° · ${fr.distance_m.toFixed(1)}m)`,
          E.clamp(edgeX - 40, r.ox + 6, r.ox + r.rw - 150), iy - 12);
        ctx.restore();
      }

      // 현재 프레임의 SAM 2 프롬프트 점 표시 (+ 초록, - 빨강)
      if (isSelected && t.prompts) {
        t.prompts.filter(pt => pt.frame === f).forEach(pt => {
          const [px, py] = videoPxToCanvas(pt.x, pt.y, r);
          ctx.save();
          ctx.fillStyle = pt.label === 1 ? '#22c55e' : '#ef4444';
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        });
      }
    });

    // 5) 카메라 캘리브레이션 임시 클릭 점
    if (app.mode === 2 && app.camClickBuffer.length > 0) {
      ctx.save();
      ctx.fillStyle = '#facc15';
      app.camClickBuffer.forEach(([vx, vy]) => {
        const [cx, cy] = videoPxToCanvas(vx, vy, r);
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    // 6) 방향 확인 클릭 마커
    if (app.clickMarker.active) {
      const [mx, my] = videoPxToCanvas(app.clickMarker.x, app.clickMarker.y, r);
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      const txt = `${app.clickMarker.az >= 0 ? '+' : ''}${app.clickMarker.az.toFixed(1)}° / ${app.clickMarker.el >= 0 ? '+' : ''}${app.clickMarker.el.toFixed(1)}°`;
      ctx.font = 'bold 11px monospace';
      const tw = ctx.measureText(txt).width;
      const bx = E.clamp(mx + 12, r.ox + 4, r.ox + r.rw - tw - 14);
      const by = E.clamp(my - 12, r.oy + 18, r.oy + r.rh - 6);
      ctx.fillRect(bx, by - 13, tw + 10, 17);
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(txt, bx + 5, by);
      ctx.restore();
    }
  }

  // 탑뷰 좌표 변환 (월드 미터 ⇄ 캔버스 픽셀)
  function getTopViewTransform(canvas) {
    const w = canvas.width, h = canvas.height;
    const baseScale = (Math.min(w, h) * 0.38) / 15.0; // 기본 반경 15m
    const pxPerM = baseScale * app.topView.zoom;
    const cx = w / 2 + app.topView.panX;
    const cy = h * 0.62 + app.topView.panY;
    return {
      w, h, cx, cy, pxPerM,
      toCanvas: (xm, ym) => [cx + xm * pxPerM, cy - ym * pxPerM],
      toWorld: (px, py) => [(px - cx) / pxPerM, (cy - py) / pxPerM]
    };
  }

  function drawTopView() {
    const c = dom.topViewCanvas;
    if (!c || !app.scene || app.viewLayout === 'video') return;
    const pw = c.parentElement.clientWidth;
    const ph = c.parentElement.clientHeight;
    if (pw < 10 || ph < 10) return;
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const tf = getTopViewTransform(c);
    const f = app.currentFrame;

    // 1) 거리 동심원 & 축 (청취자 중심)
    const lp = app.scene.listenerPos[f];
    const lyaw = app.scene.listenerYaw[f] + app.rotationCheckDeg;
    const [lcx, lcy] = tf.toCanvas(lp[0], lp[1]);

    ctx.save();
    [1, 2, 5, 10, 20, 40, 80].forEach(rm => {
      const rPx = rm * tf.pxPerM;
      if (rPx < 14 || rPx > Math.max(tf.w, tf.h) * 1.4) return;
      ctx.strokeStyle = rm === Math.round(app.project.oral_values.near_threshold_m) ? 'rgba(244,63,94,0.35)' : '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(lcx, lcy, rPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.fillText(`${rm}m`, lcx + 4, lcy - rPx + 11);
    });

    // 4스피커 방향 보조선
    E.SPEAKER_AZIMUTHS.forEach((az, i) => {
      const rad = (lyaw + az) * Math.PI / 180;
      const sx = lcx + Math.sin(rad) * 70, sy = lcy - Math.cos(rad) * 70;
      ctx.strokeStyle = 'rgba(148,163,184,0.22)';
      ctx.beginPath();
      ctx.moveTo(lcx, lcy);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.fillStyle = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899'][i];
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(E.SPEAKER_IDS[i], sx - 7, sy);
    });
    ctx.restore();

    // 2) 카메라 시야 콘 (HFOV + camera yaw)
    const cam = app.scene.camPos[f];
    const camYaw = app.scene.yawSeries[f];
    const [ccx, ccy] = tf.toCanvas(cam[0], cam[1]);
    const halfFov = (app.project.video.hfov_deg || 60) / 2 * Math.PI / 180;
    const centerAng = -Math.PI / 2 + camYaw * Math.PI / 180;
    ctx.save();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.11)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.beginPath();
    ctx.moveTo(ccx, ccy);
    ctx.arc(ccx, ccy, 12 * tf.pxPerM, centerAng - halfFov, centerAng + halfFov);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(ccx, ccy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('CAM', ccx + 8, ccy + 4);
    ctx.restore();

    // 3) 고정 음원들
    app.project.fixed_sources.forEach(fx => {
      const [x, y] = tf.toCanvas(fx.scene_xyz_m[0], fx.scene_xyz_m[1]);
      const sel = app.selected.type === 'fixed' && app.selected.id === fx.id;
      ctx.save();
      ctx.fillStyle = sel ? '#facc15' : '#fb923c';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.rect(x - 6, y - 6, 12, 12);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`📌 ${fx.id}`, x + 9, y + 4);
      ctx.restore();
    });

    // 4) 대상별 장면 동선 (화면 안 = 실선, 화면 밖 추정 = 청록 점선, 경유점 = 다이아몬드)
    app.project.targets.forEach((t, idx) => {
      const tr = app.scene.targetTracks[t.id];
      if (!tr) return;
      const isSelected = app.selected.type === 'target' && app.selected.id === t.id;
      const col = TARGET_COLORS[idx % TARGET_COLORS.length];

      for (let k = 1; k < app.scene.totalFrames; k++) {
        const a = tr.frames[k], b = tr.frames[k + 1];
        if (!a.active || !b.active) continue;
        const [x1, y1] = tf.toCanvas(a.scene_xyz[0], a.scene_xyz[1]);
        const [x2, y2] = tf.toCanvas(b.scene_xyz[0], b.scene_xyz[1]);
        ctx.save();
        if (a.estimated || b.estimated) {
          ctx.strokeStyle = '#2dd4bf'; // 타임라인 추정 구간과 동일한 청록색!
          ctx.setLineDash([5, 4]);
        } else {
          ctx.strokeStyle = col;
        }
        ctx.lineWidth = isSelected ? 2.6 : 1.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }

      // 경유점 핸들
      (t.waypoints || []).forEach((wp, wIdx) => {
        const [wx, wy] = tf.toCanvas(wp.x_m, wp.y_m);
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#2dd4bf';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.8;
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();
        ctx.fillStyle = '#99f6e4';
        ctx.font = '10px monospace';
        ctx.fillText(`WP${wIdx + 1}(f${wp.frame})`, wx + 8, wy - 6);
      });

      // 현재 프레임 대상 위치 마커
      const cur = tr.frames[f];
      if (cur && cur.active) {
        const [ox, oy] = tf.toCanvas(cur.scene_xyz[0], cur.scene_xyz[1]);
        ctx.save();
        ctx.fillStyle = cur.estimated ? '#2dd4bf' : col;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ox, oy, isSelected ? 7.5 : 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(`${t.id} (${cur.distance_m.toFixed(1)}m)`, ox + 9, oy + 4);
        ctx.restore();
      }
    });
  }

  // ===========================================================================
  // 9. 공용 멀티레인 Canvas 타임라인 (접기/줌/스크롤/드래그 지원, 다수 트랙 최적화)
  // ===========================================================================
  const LABEL_COL_W = 148;

  function buildTimelineLayout() {
    const lanes = [{ kind: 'ruler', label: '프레임 / 구간반복', h: 24 }];
    const lc = app.timeline.laneCollapsed;

    lanes.push({ kind: 'group', groupKey: 'refWave', label: `${lc.refWave ? '▸' : '▾'} 레퍼런스 파형`, h: 20 });
    if (!lc.refWave) lanes.push({ kind: 'refWave', label: '원음 오디오 파형', h: 36 });

    lanes.push({ kind: 'group', groupKey: 'viewSeg', label: `${lc.viewSeg ? '▸' : '▾'} 시점 · 수평 회전`, h: 20 });
    if (!lc.viewSeg) {
      lanes.push({ kind: 'viewSeg', label: '시점 구간 (1/3인칭)', h: 24 });
      lanes.push({ kind: 'yawKf', label: '수평 회전 (드래그 생성)', h: 26 });
    }

    lanes.push({ kind: 'group', groupKey: 'targets', label: `${lc.targets ? '▸' : '▾'} 대상 동선 (${app.project.targets.length})`, h: 20 });
    if (!lc.targets) {
      app.project.targets.forEach((t, idx) => {
        lanes.push({ kind: 'target', target: t, idx, label: `🎯 ${t.id}`, h: 24 });
      });
    }

    lanes.push({ kind: 'group', groupKey: 'sources', label: `${lc.sources ? '▸' : '▾'} 음원 구간 (${app.project.sources.length})`, h: 20 });
    if (!lc.sources) {
      app.project.sources.forEach(s => {
        lanes.push({ kind: 'source', source: s, label: `${s.muted ? '🔇' : '🔊'} ${s.id}`, h: 24 });
      });
    }

    let y = 0;
    lanes.forEach(l => { l.y = y; y += l.h; });
    return { lanes, totalHeight: Math.max(90, y + 4) };
  }

  function drawSharedTimeline() {
    const c = dom.timelineCanvas;
    const wrap = dom.timelineScrollWrap;
    if (!c || !wrap || !app.scene || app.timeline.collapsed) return;

    const layout = buildTimelineLayout();
    const wrapW = Math.max(320, wrap.clientWidth);
    const trackAreaW = Math.max(wrapW - LABEL_COL_W, Math.round((wrapW - LABEL_COL_W) * app.timeline.zoom));
    const totalW = LABEL_COL_W + trackAreaW;

    if (c.width !== totalW || c.height !== layout.totalHeight) {
      c.width = totalW;
      c.height = layout.totalHeight;
    }

    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, totalW, layout.totalHeight);
    const totalF = app.scene.totalFrames;
    const fToX = f => LABEL_COL_W + ((f - 1) / Math.max(1, totalF - 1)) * (trackAreaW - 12) + 6;
    const scrollX = wrap.scrollLeft || 0;

    // 트랙 배경 및 줄 그림
    layout.lanes.forEach(lane => {
      ctx.fillStyle = lane.kind === 'group' ? '#0f172a' : (lane.kind === 'ruler' ? '#090e1a' : '#111a2e');
      ctx.fillRect(0, lane.y, totalW, lane.h);
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(0, lane.y + lane.h);
      ctx.lineTo(totalW, lane.y + lane.h);
      ctx.stroke();

      if (lane.kind === 'ruler') {
        // 구간 반복 표시
        if (app.loopRange.enabled) {
          const lx1 = fToX(app.loopRange.start), lx2 = fToX(app.loopRange.end);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
          ctx.fillRect(lx1, lane.y, Math.max(2, lx2 - lx1), lane.h);
        }
        const step = Math.max(1, Math.round(totalF / (10 * app.timeline.zoom)));
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px monospace';
        for (let f = 1; f <= totalF; f += step) {
          const x = fToX(f);
          ctx.fillRect(x, lane.y + 15, 1, 9);
          ctx.fillText(`f${f}`, x + 3, lane.y + 12);
        }
      } else if (lane.kind === 'refWave') {
        const peaks = app.refWaveformPeaks;
        const midY = lane.y + lane.h / 2;
        if (peaks && peaks.length) {
          ctx.strokeStyle = '#60a5fa';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i < peaks.length; i++) {
            const x = LABEL_COL_W + 6 + (i / peaks.length) * (trackAreaW - 12);
            const amp = peaks[i] * (lane.h * 0.44);
            ctx.moveTo(x, midY - amp);
            ctx.lineTo(x, midY + amp);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = '#64748b';
          ctx.font = '10px sans-serif';
          ctx.fillText('영상을 열면 원음 레퍼런스 파형이 표시됩니다 (클릭 후 "여기서 시작"으로 음원 배치)', scrollX + LABEL_COL_W + 12, midY + 4);
        }
      } else if (lane.kind === 'viewSeg') {
        app.project.camera.view_segments.forEach(seg => {
          const x1 = fToX(seg.start_frame), x2 = fToX(seg.end_frame);
          const col = seg.view === 'first_person' ? '#2563eb' : (seg.view === 'third_person' ? '#059669' : '#7c3aed');
          ctx.fillStyle = col + 'aa';
          ctx.fillRect(x1, lane.y + 3, Math.max(3, x2 - x1), lane.h - 6);
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          const lbl = seg.view === 'first_person' ? '1인칭' : (seg.view === 'third_person' ? '3인칭' : '전환');
          if (x2 - x1 > 34) ctx.fillText(lbl, x1 + 5, lane.y + 15);
        });
      } else if (lane.kind === 'yawKf') {
        app.project.camera.yaw_keyframes.forEach((kf, idx) => {
          const x1 = fToX(kf.start_frame), x2 = fToX(kf.end_frame);
          const sel = app.selected.type === 'yaw_kf' && app.selected.id === idx;
          ctx.fillStyle = sel ? '#f59e0b' : '#d97706aa';
          ctx.fillRect(x1, lane.y + 4, Math.max(6, x2 - x1), lane.h - 8);
          ctx.fillStyle = '#fff';
          ctx.font = '10px monospace';
          ctx.fillText(`→${kf.to_deg}°`, x1 + 4, lane.y + 16);
        });
      } else if (lane.kind === 'target') {
        const t = lane.target;
        const tr = app.scene.targetTracks[t.id];
        const col = TARGET_COLORS[lane.idx % TARGET_COLORS.length];
        if (tr) {
          // 프레임 구간 막대 묶음 렌더링 (visible / estimated / uncertain)
          const bw = Math.max(1.2, (trackAreaW - 12) / totalF);
          for (let f = 1; f <= totalF; f++) {
            const fr = tr.frames[f];
            if (!fr || !fr.active) continue;
            const x = fToX(f);
            if (fr.uncertain) ctx.fillStyle = '#fbbf24';
            else if (fr.estimated) ctx.fillStyle = '#2dd4bf88'; // 탑뷰 추정 구간과 동일 색상!
            else ctx.fillStyle = col + 'bb';
            ctx.fillRect(x, lane.y + 5, bw + 0.5, lane.h - 10);
          }
          // 프롬프트 및 수동 키프레임 마커
          (t.prompts || []).forEach(pt => {
            const x = fToX(pt.frame);
            ctx.fillStyle = pt.label === 1 ? '#4ade80' : '#f87171';
            ctx.fillRect(x - 2, lane.y + 2, 4, lane.h - 4);
          });
          (t.manual_keyframes || []).forEach(kf => {
            const x = fToX(kf.frame);
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(x - 2, lane.y + 3, 4, lane.h - 6);
          });
        }
      } else if (lane.kind === 'source') {
        const s = lane.source;
        const buf = app.audioBuffers.get(s.file);
        const startF = s.start_frame || 1;
        const autoEndF = buf ? Math.min(totalF, startF + Math.round(buf.duration * app.scene.fps)) : totalF;
        const endF = s.end_frame || autoEndF;
        const x1 = fToX(startF), x2 = fToX(endF);
        const col = TYPE_COLORS[s.type] || '#38bdf8';
        const sel = app.selected.type === 'source' && app.selected.id === s.id;
        ctx.fillStyle = s.muted ? '#47556988' : (col + (sel ? 'dd' : '99'));
        ctx.fillRect(x1, lane.y + 3, Math.max(6, x2 - x1), lane.h - 6);
        if (sel) {
          ctx.strokeStyle = '#ffffff';
          ctx.strokeRect(x1, lane.y + 3, Math.max(6, x2 - x1), lane.h - 6);
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        if (x2 - x1 > 40) ctx.fillText(`${s.file || s.id}`, x1 + 5, lane.y + 15);
      }
    });

    // 드래그 중인 수평 회전 생성 미리보기
    if (app.timeline.dragging && app.timeline.dragging.mode === 'create_yaw') {
      const d = app.timeline.dragging;
      const x1 = fToX(Math.min(d.fStart, d.fCur)), x2 = fToX(Math.max(d.fStart, d.fCur));
      ctx.fillStyle = 'rgba(251, 191, 36, 0.5)';
      ctx.fillRect(x1, d.laneY + 3, Math.max(4, x2 - x1), 20);
    }

    // 고정 왼쪽 라벨 열 (스크롤되어도 항상 왼쪽에 고정 표시)
    layout.lanes.forEach(lane => {
      ctx.fillStyle = lane.kind === 'group' ? '#0b1324' : '#0f172a';
      ctx.fillRect(scrollX, lane.y, LABEL_COL_W, lane.h);
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(scrollX, lane.y, LABEL_COL_W, lane.h);
      ctx.fillStyle = lane.kind === 'group' ? '#38bdf8' : '#cbd5e1';
      ctx.font = lane.kind === 'group' ? 'bold 10px sans-serif' : '11px sans-serif';
      ctx.fillText(lane.label.slice(0, 18), scrollX + 8, lane.y + lane.h / 2 + 4);
    });

    // 재생 위치 선 (Playhead)
    const phX = fToX(app.currentFrame);
    ctx.save();
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, layout.totalHeight);
    ctx.stroke();
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.moveTo(phX - 5, 0);
    ctx.lineTo(phX + 5, 0);
    ctx.lineTo(phX, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ===========================================================================
  // 10. 이벤트 핸들러 (영상 클릭 · 탑뷰 조작 · 타임라인 드래그 · 파일 열기)
  // ===========================================================================
  function bindCanvasInteractions() {
    // 1) 영상 캔버스 좌/우클릭
    dom.videoCanvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (app.mode === 3 && app.selected.type === 'target' && app.selected.id) {
        const r = getVideoContentRect(dom.videoCanvas);
        const rect = dom.videoCanvas.getBoundingClientRect();
        const [vx, vy] = canvasToVideoPx(e.clientX - rect.left, e.clientY - rect.top, r);
        handleTargetVideoClick(app.selected.id, vx, vy, 0); // 우클릭 = 제외(0)
      }
    });

    dom.videoCanvas.addEventListener('click', e => {
      const r = getVideoContentRect(dom.videoCanvas);
      const rect = dom.videoCanvas.getBoundingClientRect();
      const [vx, vy] = canvasToVideoPx(e.clientX - rect.left, e.clientY - rect.top, r);

      // 항상 화각 기준 클릭 방향도 갱신
      const intr = app.scene.intrinsics;
      const hz = app.scene.horizons[app.currentFrame];
      const { azCam, elCam } = E.pixelToCameraAngles(vx, vy, intr, hz.rollDeg);
      app.clickMarker = { active: true, x: vx, y: vy, az: azCam, el: elCam + hz.pitchDeg };

      if (app.mode === 2 && app.camClickTool !== 'none') {
        handleCameraToolClick(vx, vy);
      } else if (app.mode === 3) {
        if (!app.project.targets.length) addTarget();
        const tid = (app.selected.type === 'target' && app.selected.id) ? app.selected.id : app.project.targets[0].id;
        handleTargetVideoClick(tid, vx, vy, e.shiftKey ? 0 : 1);
      } else if (app.mode === 4) {
        // 땅 클릭 → 고정 음원 추가
        recordUndoSnapshot();
        const xyz = E.projectVideoGroundClick(vx, vy, app.currentFrame, app.scene);
        const newId = nextUniqueId('fixed', app.project.fixed_sources.map(x => x.id));
        app.project.fixed_sources.push({ id: newId, from_target: null, frame: app.currentFrame, scene_xyz_m: xyz });
        app.selected = { type: 'fixed', id: newId };
        recomputeAll(true);
        setStatusMessage(`고정 음원 '${newId}' 추가됨: [${xyz[0]}, ${xyz[1]}, 0] m`);
      } else {
        requestViewportRedraw();
      }
    });

    // 2) 탑뷰 마우스 조작 (드래그 이동, 더블클릭 경유점 추가, 휠 확대, 우클릭 팬)
    dom.topViewCanvas.addEventListener('contextmenu', e => e.preventDefault());

    dom.topViewCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      app.topView.zoom = E.clamp(app.topView.zoom * factor, 0.2, 12.0);
      requestViewportRedraw();
    }, { passive: false });

    dom.topViewCanvas.addEventListener('dblclick', e => {
      const target = (app.selected.type === 'target' && app.project.targets.find(t => t.id === app.selected.id)) || app.project.targets[0];
      if (!target) {
        setStatusMessage('경유점을 추가할 대상을 먼저 선택하세요.');
        return;
      }
      recordUndoSnapshot();
      const rect = dom.topViewCanvas.getBoundingClientRect();
      const tf = getTopViewTransform(dom.topViewCanvas);
      const [xm, ym] = tf.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      target.waypoints = target.waypoints || [];
      const existing = target.waypoints.find(w => w.frame === app.currentFrame);
      if (existing) {
        existing.x_m = Math.round(xm * 100) / 100;
        existing.y_m = Math.round(ym * 100) / 100;
      } else {
        target.waypoints.push({
          frame: app.currentFrame,
          x_m: Math.round(xm * 100) / 100,
          y_m: Math.round(ym * 100) / 100,
          z_m: target.sound_height_m ?? app.project.oral_values.sound_height_m ?? 1.2
        });
      }
      recomputeAll(true);
      setStatusMessage(`대상 '${target.id}'에 경유점(f${app.currentFrame})을 추가했습니다.`);
    });

    dom.topViewCanvas.addEventListener('mousedown', e => {
      const rect = dom.topViewCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const tf = getTopViewTransform(dom.topViewCanvas);

      if (e.button === 2 || e.altKey) {
        app.topView.dragging = { kind: 'pan', startX: mx, startY: my, origPanX: app.topView.panX, origPanY: app.topView.panY };
        return;
      }

      // 경유점 히트 테스트
      for (const t of app.project.targets) {
        for (const wp of (t.waypoints || [])) {
          const [wx, wy] = tf.toCanvas(wp.x_m, wp.y_m);
          if (Math.hypot(mx - wx, my - wy) < 12) {
            recordUndoSnapshot();
            app.selected = { type: 'target', id: t.id };
            app.topView.dragging = { kind: 'waypoint', target: t, wp };
            return;
          }
        }
      }

      // 고정 음원 히트 테스트
      for (const fx of app.project.fixed_sources) {
        const [fxX, fxY] = tf.toCanvas(fx.scene_xyz_m[0], fx.scene_xyz_m[1]);
        if (Math.hypot(mx - fxX, my - fxY) < 12) {
          recordUndoSnapshot();
          app.selected = { type: 'fixed', id: fx.id };
          app.topView.dragging = { kind: 'fixed', fixed: fx };
          renderInspector();
          return;
        }
      }

      app.topView.dragging = { kind: 'pan', startX: mx, startY: my, origPanX: app.topView.panX, origPanY: app.topView.panY };
    });

    window.addEventListener('mousemove', e => {
      if (app.topView.dragging) {
        const d = app.topView.dragging;
        const rect = dom.topViewCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (d.kind === 'pan') {
          app.topView.panX = d.origPanX + (mx - d.startX);
          app.topView.panY = d.origPanY + (my - d.startY);
          requestViewportRedraw();
        } else {
          const tf = getTopViewTransform(dom.topViewCanvas);
          const [xm, ym] = tf.toWorld(mx, my);
          if (d.kind === 'waypoint') {
            d.wp.x_m = Math.round(xm * 100) / 100;
            d.wp.y_m = Math.round(ym * 100) / 100;
            recomputeAll(true);
          } else if (d.kind === 'fixed') {
            d.fixed.scene_xyz_m[0] = Math.round(xm * 100) / 100;
            d.fixed.scene_xyz_m[1] = Math.round(ym * 100) / 100;
            recomputeAll(true);
          }
        }
      }
      if (app.timeline.dragging) handleTimelineMouseMove(e);
    });

    window.addEventListener('mouseup', () => {
      app.topView.dragging = null;
      if (app.timeline.dragging) finishTimelineDrag();
    });

    // 3) 공용 타임라인 클릭·드래그·더블클릭
    dom.timelineScrollWrap.addEventListener('scroll', () => requestViewportRedraw());
    dom.timelineCanvas.addEventListener('mousedown', handleTimelineMouseDown);
    dom.timelineCanvas.addEventListener('dblclick', handleTimelineDblClick);
  }

  function timelineEventToFrameAndLane(e) {
    const rect = dom.timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scrollX = dom.timelineScrollWrap.scrollLeft || 0;
    const layout = buildTimelineLayout();
    const lane = layout.lanes.find(l => y >= l.y && y < l.y + l.h) || layout.lanes[0];
    const trackAreaW = dom.timelineCanvas.width - LABEL_COL_W;
    const f = E.clamp(Math.round(1 + ((x - LABEL_COL_W - 6) / Math.max(1, trackAreaW - 12)) * (app.scene.totalFrames - 1)), 1, app.scene.totalFrames);
    const inLabel = (x - scrollX) < LABEL_COL_W;
    return { x, y, f, lane, inLabel };
  }

  function handleTimelineMouseDown(e) {
    if (!app.scene) return;
    const { f, lane, inLabel } = timelineEventToFrameAndLane(e);

    if (inLabel) {
      if (lane.kind === 'group') {
        app.timeline.laneCollapsed[lane.groupKey] = !app.timeline.laneCollapsed[lane.groupKey];
        requestViewportRedraw();
      } else if (lane.kind === 'target') {
        selectItem('target', lane.target.id);
      } else if (lane.kind === 'source') {
        selectItem('source', lane.source.id);
      } else if (lane.kind === 'viewSeg' || lane.kind === 'yawKf') {
        selectItem('camera', null);
      }
      return;
    }

    if (lane.kind === 'ruler') {
      if (e.shiftKey) {
        app.loopRange = { enabled: true, start: f, end: f };
        app.timeline.dragging = { mode: 'loop_range', fStart: f };
      } else {
        seekToFrame(f);
        app.timeline.dragging = { mode: 'scrub' };
      }
      return;
    }

    if (lane.kind === 'yawKf') {
      const hitIdx = app.project.camera.yaw_keyframes.findIndex(k => f >= k.start_frame && f <= k.end_frame);
      if (hitIdx >= 0) {
        recordUndoSnapshot();
        app.selected = { type: 'yaw_kf', id: hitIdx };
        renderInspector();
        const kf = app.project.camera.yaw_keyframes[hitIdx];
        app.timeline.dragging = { mode: 'move_yaw', idx: hitIdx, offsetF: f - kf.start_frame, len: kf.end_frame - kf.start_frame };
      } else {
        app.timeline.dragging = { mode: 'create_yaw', fStart: f, fCur: f, laneY: lane.y };
      }
      seekToFrame(f);
      return;
    }

    if (lane.kind === 'target') {
      selectItem('target', lane.target.id);
      const tr = app.scene.targetTracks[lane.target.id];
      const hitUnc = tr && tr.uncertainSpans.find(sp => f >= sp.start_frame && f <= sp.end_frame);
      if (hitUnc) {
        seekToFrame(hitUnc.start_frame);
        setStatusMessage(`불확실 구간(f${hitUnc.start_frame}~${hitUnc.end_frame})으로 이동했습니다. 오른쪽 속성 칸에서 보정하세요.`);
        return;
      }
      seekToFrame(f);
      app.timeline.dragging = { mode: 'scrub' };
      return;
    }

    if (lane.kind === 'source') {
      const s = lane.source;
      selectItem('source', s.id);
      const buf = app.audioBuffers.get(s.file);
      const startF = s.start_frame || 1;
      const endF = s.end_frame || (buf ? Math.min(app.scene.totalFrames, startF + Math.round(buf.duration * app.scene.fps)) : app.scene.totalFrames);
      if (f >= startF && f <= endF) {
        recordUndoSnapshot();
        const nearRightEdge = Math.abs(f - endF) <= Math.max(2, Math.round(app.scene.totalFrames * 0.01));
        app.timeline.dragging = nearRightEdge
          ? { mode: 'resize_source', source: s }
          : { mode: 'move_source', source: s, offsetF: f - startF, durationF: endF - startF, explicitEnd: s.end_frame !== null };
        return;
      }
      seekToFrame(f);
      return;
    }

    seekToFrame(f);
    app.timeline.dragging = { mode: 'scrub' };
  }

  function handleTimelineMouseMove(e) {
    const d = app.timeline.dragging;
    if (!d || !app.scene) return;
    const { f } = timelineEventToFrameAndLane(e);
    if (d.mode === 'scrub') {
      seekToFrame(f);
    } else if (d.mode === 'loop_range') {
      app.loopRange.start = Math.min(d.fStart, f);
      app.loopRange.end = Math.max(d.fStart, f);
      updateFrameReadout();
      requestViewportRedraw();
    } else if (d.mode === 'create_yaw') {
      d.fCur = f;
      requestViewportRedraw();
    } else if (d.mode === 'move_yaw') {
      const kf = app.project.camera.yaw_keyframes[d.idx];
      if (kf) {
        const ns = E.clamp(f - d.offsetF, 1, Math.max(1, app.scene.totalFrames - d.len));
        kf.start_frame = ns;
        kf.end_frame = ns + d.len;
        recomputeAll(true);
      }
    } else if (d.mode === 'move_source') {
      const ns = E.clamp(f - d.offsetF, 1, app.scene.totalFrames);
      d.source.start_frame = ns;
      if (d.explicitEnd) d.source.end_frame = Math.min(app.scene.totalFrames, ns + d.durationF);
      recomputeAll(true);
    } else if (d.mode === 'resize_source') {
      d.source.end_frame = Math.max(d.source.start_frame || 1, f);
      recomputeAll(true);
    }
  }

  function finishTimelineDrag() {
    const d = app.timeline.dragging;
    app.timeline.dragging = null;
    if (!d) return;
    if (d.mode === 'create_yaw') {
      const s = Math.min(d.fStart, d.fCur), e = Math.max(d.fStart, d.fCur);
      if (e - s >= 2) {
        recordUndoSnapshot();
        const prev = app.project.camera.yaw_keyframes;
        const lastDeg = prev.length ? prev[prev.length - 1].to_deg : 0;
        const stepDeg = Number(app.project.oral_values.turn_angle_deg) || 90;
        prev.push({ start_frame: s, end_frame: e, to_deg: lastDeg + stepDeg, interp: 'ease' });
        prev.sort((a, b) => a.start_frame - b.start_frame);
        app.selected = { type: 'camera', id: null };
        recomputeAll(true);
        setStatusMessage(`수평 회전 구간(f${s}~${e}) 생성 완료. 오른쪽 속성 칸에서 각도를 조정하세요.`);
      }
    }
    requestViewportRedraw();
  }

  function handleTimelineDblClick(e) {
    if (!app.scene) return;
    const { f, lane, inLabel } = timelineEventToFrameAndLane(e);
    if (inLabel) return;
    if (lane.kind === 'yawKf') {
      seekToFrame(f);
      addYawKeyframeAtCurrent(Number(app.project.oral_values.turn_angle_deg) || 90);
    } else if (lane.kind === 'refWave' && app.selected.type === 'source' && app.selected.id) {
      seekToFrame(f);
      setSourceStartHere(app.selected.id);
    } else if (lane.kind === 'target') {
      seekToFrame(f);
      addManualKeyframeAtCurrent();
    }
  }

  // ===========================================================================
  // 11. 카메라 캘리브레이션 · SAM 2 연동 · 음원/내보내기 액션 함수들
  // ===========================================================================
  function handleCameraToolClick(vx, vy) {
    app.camClickBuffer.push([Math.round(vx), Math.round(vy)]);
    const hz = app.project.camera.horizon;
    if (app.camClickTool === 'horizon_2pt' && app.camClickBuffer.length >= 2) {
      recordUndoSnapshot();
      const [p1, p2] = app.camClickBuffer.splice(0, 2);
      hz.method = 'click';
      hz.corrections = hz.corrections.filter(c => c.frame !== app.currentFrame);
      hz.corrections.push({ frame: app.currentFrame, p1, p2 });
      recomputeAll(true);
      setStatusMessage(`f${app.currentFrame} 지평선 두 점 보정이 저장되었습니다.`);
    } else if (app.camClickTool === 'parallel_4pt' && app.camClickBuffer.length >= 4) {
      recordUndoSnapshot();
      const pts = app.camClickBuffer.splice(0, 4);
      hz.method = 'parallel_lines';
      hz.parallel_lines.push({ frame: app.currentFrame, l1: [pts[0], pts[1]], l2: [pts[2], pts[3]] });
      recomputeAll(true);
      setStatusMessage('평행선 소실점으로부터 지평선이 계산되었습니다.');
    } else if (app.camClickTool === 'person_2pt' && app.camClickBuffer.length >= 2) {
      recordUndoSnapshot();
      const [a, b] = app.camClickBuffer.splice(0, 2);
      const feet = a[1] >= b[1] ? a : b;
      const head = a[1] >= b[1] ? b : a;
      hz.method = 'known_person';
      hz.known_person.push({ frame: app.currentFrame, feet, head });
      recomputeAll(true);
      setStatusMessage('사람 발·머리 위치로부터 지평선이 계산되었습니다.');
    } else {
      renderInspector();
      requestViewportRedraw();
    }
  }

  async function runAutoHorizonDetection() {
    if (!dom.vVideo || dom.vVideo.readyState < 2) {
      logError('지평선을 검출하려면 먼저 영상을 열어 주세요.');
      return;
    }
    recordUndoSnapshot();
    const sampleCount = 8;
    const totalF = app.scene.totalFrames;
    const off = document.createElement('canvas');
    off.width = 320;
    off.height = Math.max(90, Math.round(320 * (app.project.video.height_px / app.project.video.width_px)));
    const octx = off.getContext('2d', { willReadFrequently: true });
    const origTime = dom.vVideo.currentTime;

    setBgJob(true, '영상 프레임 지평선 자동 검출 중...', 5, false);
    try {
      const profile = [];
      for (let i = 0; i < sampleCount; i++) {
        const f = Math.max(1, Math.round(1 + (i / Math.max(1, sampleCount - 1)) * (totalF - 1)));
        await seekVideoElement((f - 1) / app.scene.fps);
        octx.drawImage(dom.vVideo, 0, 0, off.width, off.height);
        const img = octx.getImageData(0, 0, off.width, off.height);
        const res = E.detectHorizonFromRgba(img.data, off.width, off.height);
        const scaleY = app.project.video.height_px / off.height;
        profile.push({ frame: f, y_px: res.y_px * scaleY, roll_deg: res.roll_deg });
        setBgJob(true, `지평선 자동 검출 중 (${i + 1}/${sampleCount})...`, ((i + 1) / sampleCount) * 100, false);
      }
      app.project.camera.horizon.method = 'auto';
      app.project.camera.horizon.auto_profile = profile;
      await seekVideoElement(origTime);
      recomputeAll(true);
      setStatusMessage('지평선 자동 검출 완료');
    } catch (err) {
      logError(`지평선 자동 검출 실패: ${err.message}`);
    } finally {
      setBgJob(false);
    }
  }

  function seekVideoElement(timeSec) {
    return new Promise((resolve) => {
      if (!dom.vVideo || Math.abs(dom.vVideo.currentTime - timeSec) < 0.002) {
        resolve();
        return;
      }
      const onDone = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { dom.vVideo.removeEventListener('seeked', onDone); resolve(); }, 1500);
      dom.vVideo.addEventListener('seeked', onDone, { once: true });
      dom.vVideo.currentTime = E.clamp(timeSec, 0, Math.max(0, (dom.vVideo.duration || 1) - 0.001));
    });
  }

  // --- SAM 2 로컬 서버 통신 ---
  async function samFetch(path, options) {
    let resp;
    try {
      resp = await fetch(SAM2_URL + path, options || {});
    } catch (_) {
      throw new Error('로컬 서버(start_sam2_server.bat / sam2_server.py)에 연결할 수 없습니다.');
    }
    const ct = resp.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await resp.json() : await resp.arrayBuffer();
    if (!resp.ok) {
      const msg = (data && data.error) ? data.error : `서버 오류 (${resp.status})`;
      throw new Error(msg);
    }
    return data;
  }

  async function checkSam2Server(silent) {
    try {
      const h = await samFetch('/health');
      app.server.connected = Boolean(h.ok);
      app.server.device = h.device || '';
      app.server.ffmpeg = Boolean(h.ffmpeg);
      if (dom.btnServerStatus) {
        dom.btnServerStatus.textContent = `🟢 서버: ${app.server.device}`;
        dom.btnServerStatus.classList.add('connected');
      }
      if (!silent) setStatusMessage(`SAM 2 로컬 서버 연결됨 (${app.server.device})`);
      if (app.selected.type === 'export' || app.selected.type === 'target') renderInspector();
      return true;
    } catch (err) {
      app.server.connected = false;
      if (dom.btnServerStatus) {
        dom.btnServerStatus.textContent = '⚪ 서버 연결';
        dom.btnServerStatus.classList.remove('connected');
      }
      if (!silent) logError(err.message);
      return false;
    }
  }

  async function uploadVideoToServerIfPossible(fileBlob, fileName) {
    const ok = await checkSam2Server(true);
    if (!ok || !fileBlob) return false;
    setBgJob(true, '로컬 서버(ffprobe)로 영상 정보 분석 중...', 30, false);
    try {
      const info = await samFetch(`/api/videos?name=${encodeURIComponent(fileName)}`, {
        method: 'POST',
        headers: { 'Content-Type': fileBlob.type || 'video/mp4' },
        body: fileBlob
      });
      app.server.sessionId = info.session_id;
      app.server.prepared = false;
      app.server.serverTargetMap.clear();
      app.server.maskCache.clear();

      app.project.video.width_px = info.width;
      app.project.video.height_px = info.height;
      app.project.video.fps = Math.round(info.fps * 1000) / 1000;
      app.project.video.frames = info.frames;
      adjustProjectToNewFrameCount(info.frames);
      recomputeAll(true);
      setStatusMessage(`영상이 서버에 로드됨: ${info.width}×${info.height}, ${app.project.video.fps} fps, ${info.frames} 프레임`);
      return true;
    } catch (err) {
      logError(`서버 영상 업로드 실패: ${err.message}`);
      return false;
    } finally {
      setBgJob(false);
    }
  }

  async function connectAndPrepareSam2() {
    const ok = await checkSam2Server(false);
    if (!ok) return;
    if (!app.server.sessionId && app.server.videoFileBlob) {
      await uploadVideoToServerIfPossible(app.server.videoFileBlob, app.project.video.file || 'video.mp4');
    }
    if (!app.server.sessionId) {
      logError('먼저 영상 파일을 열어 주세요.');
      return;
    }
    setBgJob(true, `SAM 2 추적 프레임 준비 중 (${app.server.prepWidth}px, 간격 ${app.server.prepStride})...`, 40, false);
    try {
      const prep = await samFetch(`/api/sessions/${app.server.sessionId}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: app.server.prepWidth, stride: app.server.prepStride })
      });
      app.server.prepared = true;
      app.server.serverTargetMap.clear();
      app.project.targets.forEach(t => { t.sam_stride = prep.stride; });
      setStatusMessage(`SAM 2 준비 완료 (${prep.count}장 표본 프레임). 영상에서 대상을 좌클릭하세요.`);
    } catch (err) {
      logError(err.message);
    } finally {
      setBgJob(false);
    }
  }

  async function handleTargetVideoClick(targetId, vx, vy, label) {
    const t = app.project.targets.find(x => x.id === targetId);
    if (!t) return;
    recordUndoSnapshot();

    if (t.track_tool === 'keyframe' || !app.server.connected) {
      // 수동 키프레임 기록
      t.track_tool = 'keyframe';
      t.manual_keyframes = (t.manual_keyframes || []).filter(k => k.frame !== app.currentFrame);
      t.manual_keyframes.push({ frame: app.currentFrame, x: Math.round(vx), y: Math.round(vy), visible: label !== 0 });
      t.manual_keyframes.sort((a, b) => a.frame - b.frame);
      recomputeAll(true);
      setStatusMessage(`대상 '${t.id}' f${app.currentFrame} 수동 키프레임 저장됨`);
      return;
    }

    if (!app.server.prepared) {
      await connectAndPrepareSam2();
      if (!app.server.prepared) return;
    }

    // stride 표본 프레임으로 자동 맞춤
    const stride = app.server.prepStride || 1;
    const snappedFrame = E.clamp(1 + Math.round((app.currentFrame - 1) / stride) * stride, 1, app.scene.totalFrames);
    if (snappedFrame !== app.currentFrame) seekToFrame(snappedFrame);

    try {
      let srvId = app.server.serverTargetMap.get(t.id);
      let res;
      if (!srvId) {
        if (label === 0) {
          logError('새 대상의 첫 클릭은 안쪽 포함(좌클릭)이어야 합니다.');
          return;
        }
        res = await samFetch(`/api/sessions/${app.server.sessionId}/targets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: t.id, frame: snappedFrame, x: vx, y: vy })
        });
        srvId = res.id;
        app.server.serverTargetMap.set(t.id, srvId);
      } else {
        res = await samFetch(`/api/sessions/${app.server.sessionId}/targets/${srvId}/points`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame: snappedFrame, x: vx, y: vy, label })
        });
      }
      t.sam_stride = stride;
      t.prompts = t.prompts || [];
      t.prompts.push({ frame: snappedFrame, x: Math.round(vx), y: Math.round(vy), label });
      t.raw_frames = t.raw_frames || {};
      t.raw_frames[snappedFrame] = res.metrics;
      if (res.mask_png_base64) decodeMaskBase64ToCache(t.id, snappedFrame, res.mask_png_base64);
      recomputeAll(true);
      setStatusMessage(`'${t.id}' f${snappedFrame} ${label ? '포함(+)' : '제외(-)'} 클릭 반영됨 · 마스크 확인 후 추적을 실행하세요.`);
    } catch (err) {
      logError(err.message);
    }
  }

  function decodeMaskBase64ToCache(targetId, frame, b64) {
    const img = new Image();
    img.onload = () => {
      const mc = document.createElement('canvas');
      mc.width = img.naturalWidth;
      mc.height = img.naturalHeight;
      const mctx = mc.getContext('2d', { willReadFrequently: true });
      mctx.drawImage(img, 0, 0);
      const px = mctx.getImageData(0, 0, mc.width, mc.height);
      for (let i = 0; i < px.data.length; i += 4) {
        if (px.data[i] > 127) {
          px.data[i] = 34; px.data[i + 1] = 197; px.data[i + 2] = 94; px.data[i + 3] = 105;
        } else {
          px.data[i + 3] = 0;
        }
      }
      mctx.putImageData(px, 0, 0);
      app.server.maskCache.set(`${targetId}:${frame}`, mc);
      requestViewportRedraw();
    };
    img.src = `data:image/png;base64,${b64}`;
  }

  function requestSam2MaskIfNeeded() {
    if (!app.overlays.mask || !app.server.connected || !app.server.sessionId) return;
    if (app.selected.type !== 'target' || !app.selected.id) return;
    const tid = app.selected.id;
    const srvId = app.server.serverTargetMap.get(tid);
    if (!srvId) return;
    const stride = app.server.prepStride || 1;
    const f = app.currentFrame;
    if ((f - 1) % stride !== 0) return;
    const key = `${tid}:${f}`;
    if (app.server.maskCache.has(key) || app.server.maskLoadingKey === key) return;
    app.server.maskLoadingKey = key;
    samFetch(`/api/sessions/${app.server.sessionId}/targets/${srvId}/mask/${f}`)
      .then(res => { if (res.mask_png_base64) decodeMaskBase64ToCache(tid, f, res.mask_png_base64); })
      .catch(() => {})
      .finally(() => { if (app.server.maskLoadingKey === key) app.server.maskLoadingKey = null; });
  }

  async function startSam2TargetTrack(targetId, mode) {
    const t = app.project.targets.find(x => x.id === targetId);
    const srvId = app.server.serverTargetMap.get(targetId);
    if (!t || !srvId || !app.server.sessionId) {
      logError('먼저 영상에서 대상을 클릭해 초기 마스크를 만드세요.');
      return;
    }
    const stride = app.server.prepStride || 1;
    const startFrame = E.clamp(1 + Math.round((app.currentFrame - 1) / stride) * stride, 1, app.scene.totalFrames);
    try {
      const cancelFn = () => {
        samFetch(`/api/sessions/${app.server.sessionId}/cancel`, { method: 'POST', body: '{}' }).catch(() => {});
      };
      setBgJob(true, `SAM 2 '${t.id}' 추적 중...`, 2, true, cancelFn);
      await samFetch(`/api/sessions/${app.server.sessionId}/targets/${srvId}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'from' ? { mode: 'from', frame: startFrame } : { mode: 'full' })
      });

      // 백그라운드 폴링 (편집을 막지 않음!)
      const poll = async () => {
        try {
          const st = await samFetch(`/api/sessions/${app.server.sessionId}/status`);
          const pct = (st.job.progress / Math.max(1, st.job.total)) * 100;
          if (st.job.status === 'running') {
            setBgJob(true, `SAM 2 '${t.id}' 추적 중 (${st.job.progress}/${st.job.total})...`, pct, true, cancelFn);
            setTimeout(poll, 500);
            return;
          }
          if (st.job.status === 'failed') {
            throw new Error(st.job.error || 'SAM 2 추적 실패');
          }
          const res = await samFetch(`/api/sessions/${app.server.sessionId}/targets/${srvId}/results`);
          recordUndoSnapshot();
          t.raw_frames = t.raw_frames || {};
          if (mode !== 'from') t.raw_frames = {};
          (res.frames || []).forEach(fr => { t.raw_frames[fr.frame] = fr; });
          t.sam_stride = stride;
          recomputeAll(true);
          setBgJob(false);
          setStatusMessage(`'${t.id}' 추적 완료 (${(res.frames || []).length} 표본 프레임)`);
        } catch (err) {
          setBgJob(false);
          logError(err.message);
        }
      };
      setTimeout(poll, 400);
    } catch (err) {
      setBgJob(false);
      logError(err.message);
    }
  }

  // --- 영상 열기 (모든 해상도·FPS·길이 대응!) ---
  async function openVideoFile(file) {
    if (!file) return;
    stopTransport();
    recordUndoSnapshot();
    app.server.videoFileBlob = file;
    app.project.video.file = file.name;
    if (app.project.project_name === '새 프로젝트') {
      app.project.project_name = file.name.replace(/\.[^.]+$/, '');
    }

    const blobUrl = URL.createObjectURL(file);
    dom.vVideo.src = blobUrl;
    dom.vVideo.load();
    dom.vDropOverlay.classList.add('hidden');

    await new Promise((resolve) => {
      const onMeta = () => {
        app.project.video.width_px = dom.vVideo.videoWidth || 1280;
        app.project.video.height_px = dom.vVideo.videoHeight || 720;
        const dur = Number.isFinite(dom.vVideo.duration) && dom.vVideo.duration > 0 ? dom.vVideo.duration : 30;
        const fps = app.project.video.fps || 30;
        const estFrames = Math.max(1, Math.round(dur * fps));
        app.project.video.frames = estFrames;
        adjustProjectToNewFrameCount(estFrames);
        resolve();
      };
      dom.vVideo.addEventListener('loadedmetadata', onMeta, { once: true });
      setTimeout(resolve, 2000);
    });

    // 비디오 원음에서 레퍼런스 파형 추출 시도
    extractReferenceWaveformFromFile(file);

    // 로컬 서버가 켜져 있으면 ffprobe로 정확한 실제 fps·프레임 수 덮어쓰기
    await uploadVideoToServerIfPossible(file, file.name);
    app.currentFrame = 1;
    recomputeAll(true);
  }

  function adjustProjectToNewFrameCount(newTotalFrames) {
    const segs = app.project.camera.view_segments;
    if (!segs.length) {
      app.project.camera.view_segments = [{ view: 'first_person', start_frame: 1, end_frame: newTotalFrames }];
    } else {
      segs[segs.length - 1].end_frame = newTotalFrames;
      app.project.camera.view_segments = segs.filter(s => s.start_frame <= newTotalFrames).map(s => ({
        view: s.view,
        start_frame: E.clamp(s.start_frame, 1, newTotalFrames),
        end_frame: E.clamp(s.end_frame, 1, newTotalFrames)
      }));
    }
    app.loopRange.end = newTotalFrames;
  }

  async function extractReferenceWaveformFromFile(fileBlob) {
    try {
      ensureAudioContext();
      const ab = await fileBlob.arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(ab);
      app.refAudioBuffer = audioBuf;
      buildWaveformPeaks(audioBuf);
      requestViewportRedraw();
    } catch (_) {
      // 무음 영상 트랙일 수 있음 (정상 무시)
      app.refWaveformPeaks = null;
      app.refAudioBuffer = null;
    }
  }

  function buildWaveformPeaks(audioBuf) {
    const bins = 900;
    const peaks = new Float32Array(bins);
    const ch0 = audioBuf.getChannelData(0);
    const step = Math.max(1, Math.floor(ch0.length / bins));
    let maxPeak = 0.01;
    for (let i = 0; i < bins; i++) {
      let p = 0;
      const start = i * step;
      const end = Math.min(ch0.length, start + step);
      for (let j = start; j < end; j += 4) {
        const a = Math.abs(ch0[j]);
        if (a > p) p = a;
      }
      peaks[i] = p;
      if (p > maxPeak) maxPeak = p;
    }
    for (let i = 0; i < bins; i++) peaks[i] /= maxPeak;
    app.refWaveformPeaks = peaks;
  }

  // --- 음원 파일 드래그 앤 드롭 및 추가 (채널 수 자동 판별 제안!) ---
  async function addAudioFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    ensureAudioContext();
    recordUndoSnapshot();

    for (const file of files) {
      try {
        const buf = await audioCtx.decodeAudioData(await file.arrayBuffer());
        app.audioBuffers.set(file.name, buf);

        // 기존 미연결 음원 자동 매칭
        const pending = app.project.sources.filter(s => s.file === file.name && !s._hasBuffer);
        if (pending.length) {
          pending.forEach(s => { s._hasBuffer = true; });
          continue;
        }

        const ch = buf.numberOfChannels;
        let delivery = 'Object';
        let type = 'FX';
        let link = {};
        let questions = { diegetic: true, needs_position: true, distance_changes: true };

        if (ch === 4) {
          const useFoa = confirm(`'${file.name}'은 4채널 음원입니다.\nFOA AmbiX 장면 음원(Scene)으로 등록할까요?\n(취소를 누르면 일반 4채널 Channel로 등록합니다.)`);
          if (useFoa) {
            delivery = 'Scene';
            link = { scene: 'foa_ambix' };
            questions = { diegetic: true, needs_position: false, distance_changes: false };
          } else {
            delivery = 'Channel';
            type = 'MX';
            link = { channel_rule: 'MX_quad' };
            questions = { diegetic: false, needs_position: false, distance_changes: false };
          }
        } else if (ch === 2) {
          delivery = 'Channel';
          type = 'MX';
          link = { channel_rule: 'MX_quad' };
          questions = { diegetic: false, needs_position: false, distance_changes: false };
        } else {
          delivery = 'Object';
          type = 'FX';
          if (app.project.targets.length) link = { target: app.project.targets[0].id };
        }

        const baseId = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9가-힣_-]+/g, '_');
        const id = nextUniqueId(baseId || 'src', app.project.sources.map(s => s.id));
        app.project.sources.push({
          id,
          file: file.name,
          type,
          delivery,
          link,
          start_frame: app.currentFrame,
          end_frame: null,
          questions,
          distance_cues: true,
          near_rule: true,
          note: '',
          gain_db: 0.0,
          muted: false,
          solo: false,
          _hasBuffer: true
        });
        app.selected = { type: 'source', id };
        setStatusMessage(`'${file.name}' (${ch}ch) 추가됨 → ${delivery} 방식으로 자동 제안되었습니다.`);
      } catch (err) {
        logError(`음원 '${file.name}' 디코딩 실패: ${err.message}`);
      }
    }
    rebindAudioBuffersToSources();
    recomputeAll(true);
  }

  function rebindAudioBuffersToSources() {
    app.project.sources.forEach(s => {
      s._hasBuffer = app.audioBuffers.has(s.file);
    });
  }

  // --- 일괄 내보내기 및 이름_학번.zip 생성 ---
  async function runFullExport() {
    try {
      const chkWav = document.getElementById('chkExpWav')?.checked;
      const chkMp4 = document.getElementById('chkExpMp4')?.checked;
      const chkJson = document.getElementById('chkExpJson')?.checked;
      const chkPaths = document.getElementById('chkExpPaths')?.checked;
      const chkGain = document.getElementById('chkExpGainLog')?.checked;
      const folder = (app.project.studio.export_folder || '홍길동_20260001').trim();

      const filesToExport = []; // { name, bytes (Uint8Array|Blob), mime }

      if (chkWav || chkMp4) {
        const rendered = app.renderDirty || !app.renderedBuffer ? await renderOfflineMaster() : app.renderedBuffer;
        const wavAb = E.encodeQuadWavArrayBuffer(
          [rendered.getChannelData(0), rendered.getChannelData(1), rendered.getChannelData(2), rendered.getChannelData(3)],
          rendered.sampleRate
        );
        const wavName = app.project.outputs.wav_4ch || 'mix_4ch.wav';
        if (chkWav) filesToExport.push({ name: wavName, bytes: new Uint8Array(wavAb), mime: 'audio/wav' });

        if (chkMp4) {
          if (!app.server.connected || !app.server.sessionId) {
            throw new Error('MP4 합성은 로컬 서버(start_sam2_server.bat)에 영상이 업로드된 상태에서 가능합니다.');
          }
          setBgJob(true, 'ffmpeg로 영상 + 4채널 오디오 MP4 합성 중...', 75, false);
          const mp4Ab = await samFetch(`/api/sessions/${app.server.sessionId}/mux`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: wavAb
          });
          filesToExport.push({ name: app.project.outputs.video_mp4 || 'mix_video.mp4', bytes: new Uint8Array(mp4Ab), mime: 'video/mp4' });
        }
      }

      if (chkPaths) {
        for (const t of app.project.targets) {
          const csvName = t.path_csv || `${t.id}_path.csv`;
          const csvStr = E.serializeTargetPathCsv(t.id, app.scene);
          filesToExport.push({ name: csvName, bytes: new TextEncoder().encode(csvStr), mime: 'text/csv;charset=utf-8' });
        }
      }

      if (chkGain) {
        const gainStr = E.serializeGainLogCsv(app.project, app.scene, app.rotationCheckDeg);
        filesToExport.push({ name: app.project.outputs.gain_log_csv || 'gain_log.csv', bytes: new TextEncoder().encode(gainStr), mime: 'text/csv;charset=utf-8' });
      }

      if (chkJson) {
        const stem = (app.project.video.file || 'project').replace(/\.[^.]+$/, '');
        const jsonName = `settings_${stem}.json`;
        const jsonStr = E.serializeSettingsJson(app.project);
        filesToExport.push({ name: jsonName, bytes: new TextEncoder().encode(jsonStr), mime: 'application/json' });
      }

      if (!filesToExport.length) {
        logError('내보낼 항목을 하나 이상 선택하세요.');
        return;
      }

      if (app.server.connected) {
        setBgJob(true, `서버 exports/${folder}/ 저장 및 ZIP 생성 중...`, 88, false);
        for (const item of filesToExport) {
          await samFetch(`/api/export/file?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(item.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: item.bytes
          });
        }
        const zipAb = await samFetch(`/api/export/zip?folder=${encodeURIComponent(folder)}`, { method: 'POST', body: '' });
        triggerBrowserDownload(new Blob([zipAb], { type: 'application/zip' }), `${folder}.zip`);
        setStatusMessage(`내보내기 완료! exports/${folder}/ 저장 및 ${folder}.zip 다운로드됨`);
      } else {
        filesToExport.forEach(item => {
          triggerBrowserDownload(new Blob([item.bytes], { type: item.mime }), item.name);
        });
        setStatusMessage(`${filesToExport.length}개 파일 브라우저 다운로드 완료`);
      }

      app.project.studio.checklist_done.m6_export = true;
      renderChecklist();
      updateTopBarUI();
    } catch (err) {
      logError(`내보내기 실패: ${err.message}`);
    } finally {
      setBgJob(false);
    }
  }

  function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ===========================================================================
  // 12. 보조 편집 메서드 · 단축키 · 시작 부트스트랩
  // ===========================================================================
  function nextUniqueId(prefix, existingIds) {
    const set = new Set(existingIds);
    if (!set.has(prefix)) return prefix;
    let i = 1;
    while (set.has(`${prefix}_${i}`)) i++;
    return `${prefix}_${i}`;
  }

  function addTarget() {
    recordUndoSnapshot();
    const id = nextUniqueId(`target_${app.project.targets.length + 1}`, app.project.targets.map(t => t.id));
    const knownKeys = Object.keys(app.project.oral_values.known_sizes_m || {});
    app.project.targets.push({
      id,
      kind: 'air',
      ref_point: 'bbox_center',
      track_tool: app.server.connected ? 'sam2' : 'keyframe',
      distance_method: knownKeys.length ? 'known_size' : 'ground_contact',
      size_key: knownKeys[0] || null,
      size_axis: 'max',
      sound_height_m: app.project.oral_values.sound_height_m ?? 1.2,
      path_csv: `${id}_path.csv`,
      exclude_edges: true,
      smooth_window: 3,
      bridge_gaps: true,
      extend_start: 'none',
      extend_end: 'none',
      sam_stride: app.server.prepStride || 1,
      prompts: [],
      manual_keyframes: [],
      waypoints: [],
      ignored_uncertain: [],
      raw_frames: {}
    });
    app.selected = { type: 'target', id };
    recomputeAll(true);
  }

  function addManualKeyframeAtCurrent() {
    if (app.selected.type === 'target' && app.selected.id && app.clickMarker.active) {
      handleTargetVideoClick(app.selected.id, app.clickMarker.x, app.clickMarker.y, 1);
    } else if (app.mode === 2) {
      addYawKeyframeAtCurrent(Number(app.project.oral_values.turn_angle_deg) || 90);
    } else {
      setStatusMessage('영상에서 위치를 먼저 클릭한 뒤 K를 누르면 키프레임이 추가됩니다.');
    }
  }

  function addYawKeyframeAtCurrent(deltaDeg) {
    recordUndoSnapshot();
    const span = Math.max(5, Math.round(app.scene.fps * 1.5));
    const s = app.currentFrame;
    const e = Math.min(app.scene.totalFrames, s + span);
    const list = app.project.camera.yaw_keyframes;
    const prevDeg = list.length ? list[list.length - 1].to_deg : 0;
    list.push({ start_frame: s, end_frame: e, to_deg: prevDeg + Number(deltaDeg), interp: 'ease' });
    list.sort((a, b) => a.start_frame - b.start_frame);
    recomputeAll(true);
  }

  function setViewLayout(layout) {
    app.viewLayout = layout;
    dom.viewportGrid.className = `viewport-grid layout-${layout}`;
    dom.btnViewVideo.classList.toggle('active', layout === 'video');
    dom.btnViewTop.classList.toggle('active', layout === 'top');
    dom.btnViewSplit.classList.toggle('active', layout === 'split');
    requestViewportRedraw();
  }

  function syncOverlayButtons() {
    Object.keys(app.overlays).forEach(k => {
      const btn = document.getElementById(`ovBtn_${k}`);
      if (btn) btn.classList.toggle('active', Boolean(app.overlays[k]));
    });
  }

  function bindGlobalShortcuts() {
    window.addEventListener('keydown', e => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'F1') {
        e.preventDefault();
        dom.helpModal.style.display = dom.helpModal.style.display === 'flex' ? 'none' : 'flex';
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveProjectJsonFile();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) performRedo();
        else performUndo();
        return;
      }
      if (typing) return;

      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? Math.max(1, Math.round(app.scene.fps)) : 1; // Shift+← = 1초!
        seekToFrame(app.currentFrame - step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? Math.max(1, Math.round(app.scene.fps)) : 1; // Shift+→ = 1초!
        seekToFrame(app.currentFrame + step);
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        addManualKeyframeAtCurrent();
      } else if (e.key === 'm' || e.key === 'M') {
        if (app.selected.type === 'source' && app.selected.id) {
          e.preventDefault();
          toggleSourceMute(app.selected.id);
        }
      } else if (e.key === 's' || e.key === 'S') {
        if (app.selected.type === 'source' && app.selected.id) {
          e.preventDefault();
          toggleSourceSolo(app.selected.id);
        }
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        toggleReferenceListen();
      } else if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
        e.preventDefault();
        setMode(Number(e.key));
      }
    });
  }

  function toggleReferenceListen() {
    app.listenRefMode = !app.listenRefMode;
    updateTopBarUI();
    if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
    setStatusMessage(app.listenRefMode ? '레퍼런스(원음) 모니터링으로 전환됨' : '내 4채널 공간 믹스 모니터링으로 전환됨');
  }

  function saveProjectJsonFile() {
    saveToLocalStorage();
    const stem = (app.project.video.file || app.project.project_name || 'project').replace(/\.[^.]+$/, '');
    const json = E.serializeSettingsJson(app.project);
    triggerBrowserDownload(new Blob([json], { type: 'application/json' }), `settings_${stem}.json`);
    setStatusMessage(`설정 JSON 저장 완료 (settings_${stem}.json)`);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function escJs(s) {
    return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // ===========================================================================
  // 13. 외부 노출 API (HTML 인라인 이벤트 바인딩용)
  // ===========================================================================
  window.StudioApp = {
    getState: () => app,
    setMode,
    setViewLayout,
    selectItem,
    seekToFrame,
    togglePlay,
    stopTransport,
    performUndo,
    performRedo,
    toggleManualCheck,
    jumpToWarning,
    onOralValueInput,
    addKnownSize,
    renameKnownSize,
    updateKnownSize,
    deleteKnownSize,
    toggleReferenceListen,
    checkSam2Server,
    connectAndPrepareSam2,
    playSpeakerTestTone,
    renderOfflineMaster: () => renderOfflineMaster().catch(() => {}),
    runFullExport,
    saveProjectJsonFile,

    newProject() {
      if (app.dirtySinceSave && !confirm('새 프로젝트를 시작할까요? (변경 사항은 최근 프로젝트에 자동 보관됩니다.)')) return;
      saveToLocalStorage();
      stopTransport();
      app.project = E.createDefaultProject('새 프로젝트');
      app.history.clear();
      app.server.sessionId = null;
      app.server.prepared = false;
      app.server.serverTargetMap.clear();
      app.server.maskCache.clear();
      syncOralInputsFromProject();
      setMode(1);
      recomputeAll(true);
      dom.fileInputVideo.click();
    },

    openRecentProject(idxStr) {
      if (idxStr === '') return;
      try {
        const list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
        const item = list[Number(idxStr)];
        if (item && item.json) {
          recordUndoSnapshot();
          restoreFromJsonSnapshot(item.json, `'${item.name}' 프로젝트를 불러왔습니다.`);
        }
      } catch (err) { logError(err.message); }
      dom.recentProjectsSelect.value = '';
    },

    onProjectNameChange(val) {
      app.project.project_name = val.trim() || '프로젝트';
      scheduleAutoSave();
    },

    toggleOverlay(key) {
      app.overlays[key] = !app.overlays[key];
      syncOverlayButtons();
      requestViewportRedraw();
    },

    setOutputMode(mode) {
      app.project.studio.output_mode = mode;
      rebuildMasterAudioBus();
      updateTopBarUI();
      scheduleAutoSave();
    },

    async refreshAudioDevices() {
      const sel = document.getElementById('audioSinkSelect');
      if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const outs = devs.filter(d => d.kind === 'audiooutput');
        sel.innerHTML = '<option value="">시스템 기본 출력 장치</option>' +
          outs.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || `출력 장치 (${d.deviceId.slice(0, 6)})`)}</option>`).join('');
      } catch (err) { logError(`오디오 장치 조회 실패: ${err.message}`); }
    },

    async setAudioOutputSink(sinkId) {
      ensureAudioContext();
      if (audioCtx && typeof audioCtx.setSinkId === 'function') {
        try {
          await audioCtx.setSinkId(sinkId || '');
          setStatusMessage('오디오 출력 장치가 변경되었습니다.');
        } catch (err) { logError(`출력 장치 전환 실패: ${err.message}`); }
      } else {
        setStatusMessage('현재 브라우저는 시스템 기본 출력 장치를 사용합니다.');
      }
    },

    onRotCheckInput(val) {
      app.rotationCheckDeg = Number(val) || 0;
      if (dom.lblRotCheck) dom.lblRotCheck.textContent = `${app.rotationCheckDeg >= 0 ? '+' : ''}${app.rotationCheckDeg}°`;
      if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
      requestViewportRedraw();
    },

    resetRotCheck() {
      app.rotationCheckDeg = 0;
      if (dom.slRotCheck) dom.slRotCheck.value = 0;
      if (dom.lblRotCheck) dom.lblRotCheck.textContent = '0°';
      if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
      requestViewportRedraw();
    },

    toggleLoopRange() {
      app.loopRange.enabled = !app.loopRange.enabled;
      if (app.loopRange.enabled && app.loopRange.end <= app.loopRange.start) {
        app.loopRange.start = Math.max(1, app.currentFrame);
        app.loopRange.end = Math.min(app.scene.totalFrames, app.currentFrame + Math.round(app.scene.fps * 3));
      }
      updateFrameReadout();
      requestViewportRedraw();
    },

    setSpeakerRoute(spkIdx, chVal) {
      recordUndoSnapshot();
      app.project.studio.speaker_routing[spkIdx] = Number(chVal);
      rebuildMasterAudioBus();
      recomputeAll(true);
    },

    setStudioParam(key, val) {
      app.project.studio[key] = val;
      if (key === 'master_gain' || key === 'reverb_enabled') rebuildMasterAudioBus();
      recomputeAll(key !== 'export_folder');
      scheduleAutoSave();
    },

    setManualVideoFps(val) {
      recordUndoSnapshot();
      app.project.video.fps = E.clamp(Number(val) || 30, 1, 240);
      if (dom.vVideo && Number.isFinite(dom.vVideo.duration) && dom.vVideo.duration > 0) {
        const nf = Math.max(1, Math.round(dom.vVideo.duration * app.project.video.fps));
        app.project.video.frames = nf;
        adjustProjectToNewFrameCount(nf);
      }
      recomputeAll(true);
    },

    setManualVideoFrames(val) {
      recordUndoSnapshot();
      const nf = Math.max(1, Math.round(Number(val) || 900));
      app.project.video.frames = nf;
      adjustProjectToNewFrameCount(nf);
      recomputeAll(true);
    },

    loadBuiltinPreset(key, label) {
      if (!window.PRESETS || !window.PRESETS[key]) return;
      ensureAudioContext();
      recordUndoSnapshot();
      const pr = window.PRESETS[key];
      const rows = pr.times.map((t, i) => ({
        frame: i + 1,
        time_s: t,
        azimuth_deg: pr.azimuths[i],
        elevation_deg: pr.elevations[i],
        distance_m: pr.distances[i],
        visible: 1
      }));
      app.project.video.frames = Math.max(app.project.video.frames, rows.length);
      adjustProjectToNewFrameCount(app.project.video.frames);
      const id = nextUniqueId(`preset_${label}`, app.project.sources.map(s => s.id));
      app.project.sources.push({
        id,
        file: 'Moving_sound.wav',
        type: 'FX',
        delivery: 'Object',
        link: { csv: key },
        start_frame: 1,
        end_frame: rows.length,
        questions: { diegetic: true, needs_position: true, distance_changes: true },
        distance_cues: true,
        near_rule: true,
        note: `1회차 프리셋 (${label})`,
        gain_db: 0,
        muted: false,
        solo: false,
        _hasBuffer: Boolean(builtinMovingBuf),
        _customPath: rows
      });
      app.selected = { type: 'source', id };
      recomputeAll(true);
      setStatusMessage(`프리셋 '${label}'이 음원 목록에 추가되었습니다. Space를 눌러 재생해 보세요.`);
    },

    // 카메라 편집
    setCamClickTool(tool) {
      app.camClickTool = tool;
      app.camClickBuffer = [];
      renderInspector();
      requestViewportRedraw();
    },
    updateHorizonMethod(m) {
      recordUndoSnapshot();
      app.project.camera.horizon.method = m;
      recomputeAll(true);
    },
    updatePitchInput(v) {
      recordUndoSnapshot();
      app.project.camera.horizon.pitch_input_deg = Number(v) || 0;
      app.project.camera.horizon.method = 'pitch_input';
      recomputeAll(true);
    },
    runAutoHorizonDetection,
    clearHorizonCorrections() {
      recordUndoSnapshot();
      app.project.camera.horizon.corrections = [];
      app.project.camera.horizon.parallel_lines = [];
      app.project.camera.horizon.known_person = [];
      recomputeAll(true);
    },
    setMeTarget(tid) {
      recordUndoSnapshot();
      app.project.camera.me_target = tid || null;
      recomputeAll(true);
    },
    autoJudgeViewSegments() {
      const meId = app.project.camera.me_target;
      if (!meId || !app.scene.targetTracks[meId]) {
        logError("시점을 자동 판정하려면 먼저 추적된 '나' 대상을 지정하세요.");
        return;
      }
      recordUndoSnapshot();
      app.project.camera.view_segments = E.autoDetectViewSegments(app.scene.totalFrames, app.scene.targetTracks[meId].obs);
      app.project.studio.checklist_done.m2_view = true;
      recomputeAll(true);
      setStatusMessage(`'${meId}' 가시성 기준으로 시점 구간 ${app.project.camera.view_segments.length}개가 자동 생성되었습니다.`);
    },
    updateViewSeg(idx, key, val) {
      recordUndoSnapshot();
      const seg = app.project.camera.view_segments[idx];
      if (!seg) return;
      seg[key] = key === 'view' ? val : E.clamp(Number(val) || 1, 1, app.scene.totalFrames);
      recomputeAll(true);
    },
    deleteViewSeg(idx) {
      if (app.project.camera.view_segments.length <= 1) return;
      recordUndoSnapshot();
      app.project.camera.view_segments.splice(idx, 1);
      recomputeAll(true);
    },
    splitViewSegAtCurrent() {
      const f = app.currentFrame;
      const segs = app.project.camera.view_segments;
      const idx = segs.findIndex(s => f > s.start_frame && f <= s.end_frame);
      if (idx < 0) return;
      recordUndoSnapshot();
      const orig = segs[idx];
      const nextView = orig.view === 'first_person' ? 'third_person' : 'first_person';
      segs.splice(idx, 1,
        { view: orig.view, start_frame: orig.start_frame, end_frame: f - 1 },
        { view: nextView, start_frame: f, end_frame: orig.end_frame }
      );
      recomputeAll(true);
    },
    updateCamHeight(key, val) {
      recordUndoSnapshot();
      app.project.camera.height[key] = key === 'third_person_input_m' ? (Number(val) || 2.5) : (val || null);
      recomputeAll(true);
    },
    addYawKeyframeAtCurrent,
    updateYawKf(idx, key, val) {
      recordUndoSnapshot();
      const kf = app.project.camera.yaw_keyframes[idx];
      if (!kf) return;
      kf[key] = key === 'interp' ? val : Number(val);
      app.project.camera.yaw_keyframes.sort((a, b) => a.start_frame - b.start_frame);
      recomputeAll(true);
    },
    deleteYawKf(idx) {
      recordUndoSnapshot();
      app.project.camera.yaw_keyframes.splice(idx, 1);
      recomputeAll(true);
    },
    addCameraPosKeyframe() {
      recordUndoSnapshot();
      const cur = app.scene.camPos[app.currentFrame];
      app.project.camera.pos_keyframes = (app.project.camera.pos_keyframes || []).filter(k => k.frame !== app.currentFrame);
      app.project.camera.pos_keyframes.push({ frame: app.currentFrame, x_m: cur[0], y_m: cur[1], z_m: cur[2] });
      recomputeAll(true);
    },
    clearCameraPosKeyframes() {
      recordUndoSnapshot();
      app.project.camera.pos_keyframes = [];
      recomputeAll(true);
    },

    // 대상 편집
    addTarget,
    renameTarget(oldId, newId) {
      const clean = String(newId || '').trim().replace(/[^a-zA-Z0-9가-힣_-]+/g, '_');
      if (!clean || clean === oldId || app.project.targets.some(t => t.id === clean)) { renderInspector(); return; }
      recordUndoSnapshot();
      const t = app.project.targets.find(x => x.id === oldId);
      t.id = clean;
      t.path_csv = `${clean}_path.csv`;
      if (app.project.camera.me_target === oldId) app.project.camera.me_target = clean;
      app.project.sources.forEach(s => { if (s.link && s.link.target === oldId) s.link.target = clean; });
      if (app.server.serverTargetMap.has(oldId)) {
        const v = app.server.serverTargetMap.get(oldId);
        app.server.serverTargetMap.delete(oldId);
        app.server.serverTargetMap.set(clean, v);
      }
      app.selected = { type: 'target', id: clean };
      recomputeAll(true);
    },
    deleteTarget(id) {
      recordUndoSnapshot();
      const srvId = app.server.serverTargetMap.get(id);
      if (srvId && app.server.sessionId) {
        samFetch(`/api/sessions/${app.server.sessionId}/targets/${srvId}/delete`, { method: 'POST', body: '{}' }).catch(() => {});
        app.server.serverTargetMap.delete(id);
      }
      app.project.targets = app.project.targets.filter(t => t.id !== id);
      if (app.project.camera.me_target === id) app.project.camera.me_target = null;
      app.selected = app.project.targets.length ? { type: 'target', id: app.project.targets[0].id } : { type: 'target', id: null };
      recomputeAll(true);
    },
    updateTargetProp(id, key, val) {
      recordUndoSnapshot();
      const t = app.project.targets.find(x => x.id === id);
      if (!t) return;
      t[key] = val;
      if (key === 'kind') {
        t.ref_point = val === 'ground' ? 'bbox_bottom_center' : 'bbox_center';
        t.distance_method = val === 'ground' ? 'ground_contact' : 'known_size';
      }
      recomputeAll(true);
    },
    setSamPrepOption(key, val) {
      app.server[key] = val;
      app.server.prepared = false;
    },
    startSam2TargetTrack,
    overrideUncertainWithKeyframe(id, sFrame, eFrame) {
      const t = app.project.targets.find(x => x.id === id);
      const tr = app.scene.targetTracks[id];
      if (!t || !tr) return;
      recordUndoSnapshot();
      const fBefore = Math.max(1, sFrame - 1);
      const fAfter = Math.min(app.scene.totalFrames, eFrame + 1);
      const obA = tr.obs[fBefore], obB = tr.obs[fAfter];
      const pairId = `span_${Date.now()}`;
      t.manual_keyframes = t.manual_keyframes || [];
      if (obA && obA.x_px !== null && obB && obB.x_px !== null) {
        t.manual_keyframes.push(
          { frame: fBefore, x: obA.x_px, y: obA.y_px, visible: true, span_pair: pairId },
          { frame: fAfter, x: obB.x_px, y: obB.y_px, visible: true, span_pair: pairId }
        );
      }
      for (let f = sFrame; f <= eFrame; f++) {
        if (!t.ignored_uncertain.includes(f)) t.ignored_uncertain.push(f);
      }
      recomputeAll(true);
      setStatusMessage(`f${sFrame}~${eFrame} 불확실 구간을 전후 정상 프레임 보간으로 덮어썼습니다.`);
    },
    retrackFromUncertain(id, sFrame) {
      seekToFrame(sFrame);
      setStatusMessage(`f${sFrame}로 이동했습니다. 영상에서 대상 안쪽을 다시 좌클릭한 뒤 [현재 프레임부터 이어 추적]을 누르세요.`);
    },
    ignoreUncertainSpan(id, sFrame, eFrame) {
      const t = app.project.targets.find(x => x.id === id);
      if (!t) return;
      recordUndoSnapshot();
      t.ignored_uncertain = t.ignored_uncertain || [];
      for (let f = sFrame; f <= eFrame; f++) {
        if (!t.ignored_uncertain.includes(f)) t.ignored_uncertain.push(f);
      }
      recomputeAll(false);
    },
    clearTargetManualKeyframes(id) {
      const t = app.project.targets.find(x => x.id === id);
      if (!t) return;
      recordUndoSnapshot();
      t.manual_keyframes = [];
      t.ignored_uncertain = [];
      recomputeAll(true);
    },
    clearWaypoints(id) {
      const t = app.project.targets.find(x => x.id === id);
      if (!t) return;
      recordUndoSnapshot();
      t.waypoints = [];
      recomputeAll(true);
    },
    downloadSingleTargetCsv(id) {
      try {
        const csv = E.serializeTargetPathCsv(id, app.scene);
        triggerBrowserDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${id}_path.csv`);
      } catch (err) { logError(err.message); }
    },
    createSourceFromTarget(tid) {
      recordUndoSnapshot();
      const id = nextUniqueId(`src_${tid}`, app.project.sources.map(s => s.id));
      app.project.sources.push({
        id,
        file: builtinMovingBuf ? 'Moving_sound.wav' : '',
        type: 'FX',
        delivery: 'Object',
        link: { target: tid },
        start_frame: 1,
        end_frame: null,
        questions: { diegetic: true, needs_position: true, distance_changes: true },
        distance_cues: true,
        near_rule: true,
        note: `${tid} 동선 연결`,
        gain_db: 0,
        muted: false,
        solo: false,
        _hasBuffer: Boolean(builtinMovingBuf)
      });
      app.selected = { type: 'source', id };
      setMode(5);
      recomputeAll(true);
    },

    // 장면 / 고정 음원
    updateListenerProp(key, val) {
      recordUndoSnapshot();
      app.project.listener[key] = val;
      recomputeAll(true);
    },
    addFixedSourceManual() {
      recordUndoSnapshot();
      const id = nextUniqueId('fixed', app.project.fixed_sources.map(x => x.id));
      app.project.fixed_sources.push({ id, from_target: null, frame: app.currentFrame, scene_xyz_m: [0, 3, 1.2] });
      app.selected = { type: 'fixed', id };
      recomputeAll(true);
    },
    renameFixedSource(oldId, newId) {
      const clean = String(newId || '').trim().replace(/[^a-zA-Z0-9가-힣_-]+/g, '_');
      if (!clean || clean === oldId) { renderInspector(); return; }
      recordUndoSnapshot();
      const fx = app.project.fixed_sources.find(x => x.id === oldId);
      if (fx) fx.id = clean;
      app.project.sources.forEach(s => { if (s.link && s.link.fixed === oldId) s.link.fixed = clean; });
      app.selected = { type: 'fixed', id: clean };
      recomputeAll(true);
    },
    updateFixedCoord(id, axisIdx, val) {
      recordUndoSnapshot();
      const fx = app.project.fixed_sources.find(x => x.id === id);
      if (fx) fx.scene_xyz_m[axisIdx] = Number(val) || 0;
      recomputeAll(true);
    },
    deleteFixedSource(id) {
      recordUndoSnapshot();
      app.project.fixed_sources = app.project.fixed_sources.filter(x => x.id !== id);
      app.selected = { type: 'scene', id: null };
      recomputeAll(true);
    },
    createSourceFromFixed(fid) {
      recordUndoSnapshot();
      const id = nextUniqueId(`src_${fid}`, app.project.sources.map(s => s.id));
      app.project.sources.push({
        id,
        file: builtinMovingBuf ? 'Moving_sound.wav' : '',
        type: 'FX',
        delivery: 'Object',
        link: { fixed: fid },
        start_frame: 1,
        end_frame: null,
        questions: { diegetic: true, needs_position: true, distance_changes: false },
        distance_cues: true,
        near_rule: true,
        note: `${fid} 고정 위치 연결`,
        gain_db: 0,
        muted: false,
        solo: false,
        _hasBuffer: Boolean(builtinMovingBuf)
      });
      app.selected = { type: 'source', id };
      setMode(5);
      recomputeAll(true);
    },

    // 음원 편집 (재생 중 실시간 반영!)
    toggleSourceMute(id) {
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s.muted = !s.muted;
      app.renderDirty = true;
      renderLeftLists();
      requestViewportRedraw();
      if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
      scheduleAutoSave();
    },
    toggleSourceSolo(id) {
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s.solo = !s.solo;
      app.renderDirty = true;
      renderLeftLists();
      if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
      scheduleAutoSave();
    },
    setSourceGainLive(id, dbVal, readoutEl) {
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s.gain_db = Number(dbVal) || 0;
      app.renderDirty = true;
      if (readoutEl) readoutEl.textContent = `${s.gain_db >= 0 ? '+' : ''}${s.gain_db.toFixed(1)}dB`;
      if (isPlaying) updateLiveAudioParamsAtFrame(app.currentFrame);
      scheduleAutoSave();
    },
    updateSourceQuestion(id, qKey, checked) {
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s.questions = s.questions || { diegetic: true, needs_position: true, distance_changes: true };
      s.questions[qKey] = Boolean(checked);
      renderInspector();
      scheduleAutoSave();
    },
    applySourceRecommendation(id) {
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      recordUndoSnapshot();
      const buf = app.audioBuffers.get(s.file);
      const rec = E.recommendDeliveryFromQuestions(s.questions, buf ? buf.numberOfChannels : 1);
      s.type = rec.type;
      s.delivery = rec.delivery;
      if (rec.linkHint === 'foa_ambix') s.link = { scene: 'foa_ambix' };
      else if (rec.linkHint === 'MX_quad' || rec.linkHint === 'DX_center') s.link = { channel_rule: rec.linkHint };
      else if (rec.linkHint === 'fixed' && app.project.fixed_sources.length) s.link = { fixed: app.project.fixed_sources[0].id };
      else if (rec.linkHint === 'target' && app.project.targets.length) s.link = { target: app.project.targets[0].id };
      recomputeAll(true);
    },
    renameSource(oldId, newId) {
      const clean = String(newId || '').trim();
      if (!clean || clean === oldId) return;
      recordUndoSnapshot();
      const s = app.project.sources.find(x => x.id === oldId);
      if (s) s.id = clean;
      app.selected = { type: 'source', id: clean };
      recomputeAll(false);
    },
    updateSourceProp(id, key, val) {
      recordUndoSnapshot();
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s[key] = val;
      if (key === 'delivery') {
        if (val === 'Scene') s.link = { scene: 'foa_ambix' };
        else if (val === 'Channel') s.link = { channel_rule: s.type === 'MX' ? 'MX_quad' : 'DX_center' };
        else s.link = app.project.targets.length ? { target: app.project.targets[0].id } : {};
      }
      recomputeAll(true);
    },
    updateSourceLink(id, kind, val) {
      recordUndoSnapshot();
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s.link = val ? { [kind]: val } : {};
      recomputeAll(true);
    },
    setSourceStartHere(id) {
      recordUndoSnapshot();
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      s.start_frame = app.currentFrame;
      recomputeAll(true);
      setStatusMessage(`음원 '${s.id}' 시작 프레임을 f${app.currentFrame}로 설정했습니다.`);
    },
    fitSourceEndToBuffer(id) {
      const s = app.project.sources.find(x => x.id === id);
      const buf = s && app.audioBuffers.get(s.file);
      if (!s || !buf) return;
      recordUndoSnapshot();
      s.end_frame = Math.min(app.scene.totalFrames, (s.start_frame || 1) + Math.round(buf.duration * app.scene.fps));
      recomputeAll(true);
    },
    duplicateSource(id) {
      const s = app.project.sources.find(x => x.id === id);
      if (!s) return;
      recordUndoSnapshot();
      const copy = E.deepClone(s);
      copy.id = nextUniqueId(`${s.id}_copy`, app.project.sources.map(x => x.id));
      copy.start_frame = app.currentFrame;
      copy._hasBuffer = s._hasBuffer;
      copy._customPath = s._customPath;
      app.project.sources.push(copy);
      app.selected = { type: 'source', id: copy.id };
      recomputeAll(true);
    },
    deleteSource(id) {
      recordUndoSnapshot();
      app.project.sources = app.project.sources.filter(x => x.id !== id);
      app.selected = app.project.sources.length ? { type: 'source', id: app.project.sources[0].id } : { type: 'source', id: null };
      recomputeAll(true);
    },
    previewSingleSource(id) {
      const s = app.project.sources.find(x => x.id === id);
      const buf = s && app.audioBuffers.get(s.file);
      if (!buf) { logError('먼저 해당 음원의 오디오 파일을 연결하세요.'); return; }
      stopTransport();
      ensureAudioContext();
      const node = audioCtx.createBufferSource();
      node.buffer = buf;
      node.connect(audioCtx.destination);
      node.start();
      liveNodes.push({ source: s, node, trimGain: audioCtx.createGain(), lpf: audioCtx.createBiquadFilter(), spkGains: [], revSend: audioCtx.createGain() });
      setStatusMessage(`'${s.file}' 단독 미리듣기 중...`);
    },

    // 타임라인 제어
    onTimelineZoom(val) {
      app.timeline.zoom = Number(val) || 1;
      requestViewportRedraw();
    },
    toggleCollapseTimeline() {
      app.timeline.collapsed = !app.timeline.collapsed;
      dom.timelineBody.style.display = app.timeline.collapsed ? 'none' : 'block';
      dom.btnCollapseTimeline.textContent = app.timeline.collapsed ? '▴ 타임라인 펼치기' : '▾ 타임라인 접기';
      requestViewportRedraw();
    }
  };

  // ===========================================================================
  // 14. DOM 로드 시 앱 시작
  // ===========================================================================
  window.addEventListener('DOMContentLoaded', () => {
    cacheDom();

    // 자동 저장 복원 시도
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        app.project = E.deserializeSettingsJson(saved);
        app.saveStatus = '이전 자동 저장 복원됨';
        if (dom.saveStatusText) dom.saveStatusText.textContent = app.saveStatus;
      }
    } catch (_) {}

    renderRecentProjectsDropdown();
    syncOralInputsFromProject();
    bindCanvasInteractions();
    bindGlobalShortcuts();

    // 파일 입력 및 드래그 앤 드롭 연결
    dom.fileInputVideo.addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) openVideoFile(f);
    });

    dom.fileInputProject.addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        recordUndoSnapshot();
        restoreFromJsonSnapshot(await f.text(), `'${f.name}' 설정 파일을 불러왔습니다.`);
      } catch (err) { logError(`설정 파일 읽기 오류: ${err.message}`); }
    });

    dom.fileInputAudio.addEventListener('change', e => {
      addAudioFiles(e.target.files);
      e.target.value = '';
    });

    dom.fileInputRefAudio.addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      await extractReferenceWaveformFromFile(f);
      setStatusMessage(`레퍼런스 오디오 '${f.name}' 파형 로드 완료`);
    });

    // 창 전체 드래그 앤 드롭 (영상 / 오디오 / JSON 자동 구분!)
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      const vid = files.find(f => /\.(mp4|mov|webm|mkv)$/i.test(f.name));
      const json = files.find(f => /\.json$/i.test(f.name));
      const audios = files.filter(f => /\.(wav|mp3|ogg|flac|m4a)$/i.test(f.name));
      if (vid) await openVideoFile(vid);
      if (json) {
        try {
          recordUndoSnapshot();
          restoreFromJsonSnapshot(await json.text(), `'${json.name}' 설정 로드 완료`);
        } catch (err) { logError(err.message); }
      }
      if (audios.length) await addAudioFiles(audios);
    });

    dom.btnBgCancel.addEventListener('click', () => {
      if (app.bgJob.onCancel) app.bgJob.onCancel();
      setBgJob(false);
    });

    dom.warnBadgeBtn.addEventListener('click', () => {
      const vis = dom.warnPopover.style.display === 'block';
      dom.warnPopover.style.display = vis ? 'none' : 'block';
    });

    window.addEventListener('resize', requestViewportRedraw);

    // 줌 변경(75% ↔ 100% ↔ 125%) 및 패널 리사이즈 즉시 감지
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => requestViewportRedraw());
      if (dom.videoPane) ro.observe(dom.videoPane);
      if (dom.topViewPane) ro.observe(dom.topViewPane);
      if (dom.timelineScrollWrap) ro.observe(dom.timelineScrollWrap);
    }

    // 좌우 사이드바 너비 드래그 조절 (항상 최소·최대 범위 내에서 두 사이드바가 화면 안에 유지되도록 제한)
    const wsGrid = document.querySelector('.workspace-grid');
    const resL = document.getElementById('resizerLeft');
    const resR = document.getElementById('resizerRight');
    let activeResizer = null;
    if (resL) resL.addEventListener('mousedown', e => { e.preventDefault(); activeResizer = 'left'; resL.classList.add('dragging'); });
    if (resR) resR.addEventListener('mousedown', e => { e.preventDefault(); activeResizer = 'right'; resR.classList.add('dragging'); });
    window.addEventListener('mousemove', e => {
      if (!activeResizer || !wsGrid) return;
      const totalW = wsGrid.clientWidth || window.innerWidth;
      if (activeResizer === 'left') {
        const w = E.clamp(e.clientX, 230, Math.floor(totalW * 0.34));
        wsGrid.style.setProperty('--left-pane-w', `${w}px`);
      } else if (activeResizer === 'right') {
        const w = E.clamp(totalW - e.clientX, 260, Math.floor(totalW * 0.36));
        wsGrid.style.setProperty('--right-pane-w', `${w}px`);
      }
      requestViewportRedraw();
    });
    window.addEventListener('mouseup', () => {
      if (!activeResizer) return;
      activeResizer = null;
      if (resL) resL.classList.remove('dragging');
      if (resR) resR.classList.remove('dragging');
    });

    // 백그라운드로 로컬 서버 조용히 확인
    checkSam2Server(true);
    setMode(1);
    recomputeAll(true);
    updateUndoRedoButtons();
  });
})();
