/**
 * XR 사운드 디자인 스튜디오 — 순수 계산·데이터·직렬화 모듈 (DOM 비의존)
 * - 좌표계: 1기반 프레임(1..frames), 방위각·yaw 우측(+), 고도·pitch 상향(+), 거리(m)
 * - 장면 좌표: X 우측(+), Y 정면(+), Z 상향(+) [지면 z = 0]
 * - 설정 형식: isad-session3-settings (version 1) 준수 + 스튜디오 편집 메타 보존
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StudioEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SPEAKER_AZIMUTHS = [-30.0, 30.0, -135.0, 135.0]; // FL, FR, RL, RR
  const SPEAKER_IDS = ['FL', 'FR', 'RL', 'RR'];
  const DEG2RAD = Math.PI / 180.0;
  const RAD2DEG = 180.0 / Math.PI;
  const SPEED_OF_SOUND = 343.0;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function wrapDeg(deg) {
    let a = ((Number(deg) || 0) + 180.0) % 360.0;
    if (a < 0) a += 360.0;
    return a - 180.0;
  }

  function lerpAngleDeg(a, b, t) {
    const diff = wrapDeg(b - a);
    return wrapDeg(a + diff * t);
  }

  function smoothstep(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ===========================================================================
  // 1. 기본 프로젝트 상태 생성 (settings_template.json 호환)
  // ===========================================================================
  function createDefaultProject(name) {
    return {
      format: 'isad-session3-settings',
      version: 1,
      project_name: name || '새 프로젝트',
      video: {
        file: null,
        width_px: 1280,
        height_px: 720,
        fps: 30,
        frames: 900,
        hfov_deg: 60.0
      },
      oral_values: {
        person_height_m: 1.7,
        eye_height_m: 1.6,
        sound_height_m: 1.2,
        turn_angle_deg: 90.0,
        near_threshold_m: 1.5,
        atten_ref_m: 2.0,
        atten_k: 1.0,
        confidence_threshold: 0.5,
        known_sizes_m: {}
      },
      listener: {
        reference: 'camera',
        me_ear_height_m: 1.6,
        me_facing_deg: 0.0
      },
      camera: {
        me_target: null,
        horizon: {
          method: 'auto',
          pitch_input_deg: 0.0,
          corrections: [],
          parallel_lines: [],   // [{frame, l1:[p1,p2], l2:[p3,p4]}]
          known_person: [],     // [{frame, feet:[x,y], head:[x,y]}]
          auto_profile: []      // [{frame, y_px, roll_deg}]
        },
        view_segments: [
          { view: 'first_person', start_frame: 1, end_frame: 900 }
        ],
        height: {
          first_person_m: 1.6,
          third_person_method: 'from_person',
          third_person_input_m: 2.5,
          height_person_target: null
        },
        yaw_keyframes: [],
        pos_keyframes: []       // [{frame, x_m, y_m, z_m}] 수동 카메라 위치 보정용
      },
      targets: [],
      fixed_sources: [],
      sources: [],
      outputs: {
        wav_4ch: 'mix_4ch.wav',
        video_mp4: 'mix_video.mp4',
        gain_log_csv: 'gain_log.csv',
        path_csvs: []
      },
      studio: {
        export_folder: '홍길동_20260001',
        output_mode: 'downmix',
        speaker_routing: [0, 1, 2, 3],
        master_gain: 1.0,
        doppler_enabled: false,
        air_absorption: true,
        reverb_enabled: true,
        elevation_spread: 1.0,
        front_back_bias_db: 0.0,
        checklist_done: {}
      }
    };
  }

  // ===========================================================================
  // 2. 카메라 광학 · 지평선 · 시점 · 높이 · 수평 회전 · 카메라 위치
  // ===========================================================================
  function computeIntrinsics(video) {
    const w = Math.max(2, Number(video.width_px) || 1280);
    const h = Math.max(2, Number(video.height_px) || 720);
    const hfov = clamp(Number(video.hfov_deg) || 60.0, 5.0, 175.0);
    const focalPx = (w / 2.0) / Math.tan((hfov * DEG2RAD) / 2.0);
    const vfov = 2.0 * Math.atan((h / 2.0) / focalPx) * RAD2DEG;
    return { width: w, height: h, hfovDeg: hfov, vfovDeg: vfov, focalPx };
  }

  function pixelToCameraAngles(pxX, pxY, intrinsics, rollDeg) {
    let dx = pxX - intrinsics.width / 2.0;
    let dy = intrinsics.height / 2.0 - pxY;
    if (rollDeg) {
      const r = rollDeg * DEG2RAD;
      const c = Math.cos(r), s = Math.sin(r);
      const rx = dx * c - dy * s;
      const ry = dx * s + dy * c;
      dx = rx;
      dy = ry;
    }
    const f = intrinsics.focalPx;
    const azCam = Math.atan2(dx, f) * RAD2DEG;
    const elCam = Math.atan2(dy, Math.hypot(dx, f)) * RAD2DEG;
    return { dx, dy, azCam, elCam };
  }

  function lineIntersection(p1, p2, p3, p4) {
    const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-6) return null;
    const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denom;
    const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denom;
    return [px, py];
  }

  function interpolateKeyedScalar(items, frame, getVal, defaultVal) {
    if (!items || !items.length) return defaultVal;
    const sorted = items.slice().sort((a, b) => a.frame - b.frame);
    if (frame <= sorted[0].frame) return getVal(sorted[0]);
    if (frame >= sorted[sorted.length - 1].frame) return getVal(sorted[sorted.length - 1]);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        const t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
        return getVal(a) + t * (getVal(b) - getVal(a));
      }
    }
    return defaultVal;
  }

  function computeHorizonAtFrame(project, frame, intrinsics) {
    const hz = project.camera.horizon || {};
    const h = intrinsics.height;
    const w = intrinsics.width;
    const f = intrinsics.focalPx;

    // 수동 두 점 보정이 있으면 최우선 적용 (또는 method === 'click')
    const corr = hz.corrections || [];
    if ((hz.method === 'click' || corr.length > 0) && corr.length > 0) {
      const entryFromTwoPts = (item) => {
        const [x1, y1] = item.p1;
        const [x2, y2] = item.p2;
        const roll = Math.atan2(y2 - y1, x2 - x1) * RAD2DEG;
        const midX = (x1 + x2) / 2.0, midY = (y1 + y2) / 2.0;
        // 화면 가로 중앙에서의 지평선 Y
        const slope = Math.abs(x2 - x1) > 1e-3 ? (y2 - y1) / (x2 - x1) : 0;
        const yCenter = midY + slope * (w / 2.0 - midX);
        return { yCenter, roll };
      };
      const yCenter = interpolateKeyedScalar(corr, frame, it => entryFromTwoPts(it).yCenter, h / 2.0);
      const roll = interpolateKeyedScalar(corr, frame, it => entryFromTwoPts(it).roll, 0.0);
      const pitchDeg = Math.atan2(yCenter - h / 2.0, f) * RAD2DEG;
      return { yPx: yCenter, pitchDeg, rollDeg: roll, method: 'click' };
    }

    if (hz.method === 'pitch_input') {
      const pitchDeg = Number(hz.pitch_input_deg) || 0.0;
      const yPx = h / 2.0 + f * Math.tan(pitchDeg * DEG2RAD);
      return { yPx, pitchDeg, rollDeg: 0.0, method: 'pitch_input' };
    }

    if (hz.method === 'parallel_lines' && hz.parallel_lines && hz.parallel_lines.length > 0) {
      const yPx = interpolateKeyedScalar(hz.parallel_lines, frame, it => {
        const vp = lineIntersection(it.l1[0], it.l1[1], it.l2[0], it.l2[1]);
        return vp ? vp[1] : h / 2.0;
      }, h / 2.0);
      const pitchDeg = Math.atan2(yPx - h / 2.0, f) * RAD2DEG;
      return { yPx, pitchDeg, rollDeg: 0.0, method: 'parallel_lines' };
    }

    if (hz.method === 'known_person' && hz.known_person && hz.known_person.length > 0) {
      const personH = Math.max(0.5, Number(project.oral_values.person_height_m) || 1.7);
      const camH = Math.max(0.3, Number(project.camera.height.first_person_m ?? project.oral_values.eye_height_m) || 1.6);
      const yPx = interpolateKeyedScalar(hz.known_person, frame, it => {
        const feetY = it.feet[1], headY = it.head[1];
        return feetY - (camH / personH) * (feetY - headY);
      }, h / 2.0);
      const pitchDeg = Math.atan2(yPx - h / 2.0, f) * RAD2DEG;
      return { yPx, pitchDeg, rollDeg: 0.0, method: 'known_person' };
    }

    if (hz.auto_profile && hz.auto_profile.length > 0) {
      const yPx = interpolateKeyedScalar(hz.auto_profile, frame, it => it.y_px, h / 2.0);
      const roll = interpolateKeyedScalar(hz.auto_profile, frame, it => it.roll_deg || 0, 0.0);
      const pitchDeg = Math.atan2(yPx - h / 2.0, f) * RAD2DEG;
      return { yPx, pitchDeg, rollDeg: roll, method: 'auto' };
    }

    const fallbackPitch = Number(hz.pitch_input_deg) || 0.0;
    const yPx = h / 2.0 + f * Math.tan(fallbackPitch * DEG2RAD);
    return { yPx, pitchDeg: fallbackPitch, rollDeg: 0.0, method: hz.method || 'auto' };
  }

  /**
   * 이미지 그레이스케일/색상 수직 경계 에너지로 지평선 Y 위치를 추정한다 (브라우저 ImageData용 순수 배열 연산)
   */
  function detectHorizonFromRgba(rgba, width, height) {
    const stepX = Math.max(1, Math.floor(width / 80));
    const yMin = Math.floor(height * 0.12);
    const yMax = Math.floor(height * 0.88);
    let bestY = height / 2.0;
    let bestRoll = 0.0;
    let bestScore = -1;

    const lumAt = (x, y) => {
      const cx = clamp(Math.round(x), 0, width - 1);
      const cy = clamp(Math.round(y), 0, height - 1);
      const idx = (cy * width + cx) * 4;
      return 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    };
    const blueDiffAt = (x, y) => {
      const cx = clamp(Math.round(x), 0, width - 1);
      const cy = clamp(Math.round(y), 0, height - 1);
      const idx = (cy * width + cx) * 4;
      return rgba[idx + 2] - 0.5 * (rgba[idx] + rgba[idx + 1]);
    };

    for (const rollDeg of [-6, -3, -1.5, 0, 1.5, 3, 6]) {
      const tanR = Math.tan(rollDeg * DEG2RAD);
      for (let y0 = yMin; y0 <= yMax; y0 += 2) {
        let edgeSum = 0;
        let skyGroundContrast = 0;
        let count = 0;
        for (let x = 0; x < width; x += stepX) {
          const y = y0 + (x - width / 2.0) * tanR;
          if (y < 4 || y >= height - 5) continue;
          const gLum = Math.abs(lumAt(x, y + 2) - lumAt(x, y - 2));
          const gSky = Math.max(0, blueDiffAt(x, y - 4) - blueDiffAt(x, y + 4));
          edgeSum += gLum;
          skyGroundContrast += gSky;
          count++;
        }
        if (count > 10) {
          const centerPrior = 1.0 - 0.18 * Math.abs((y0 - height / 2) / (height / 2));
          const score = ((edgeSum / count) + 0.8 * (skyGroundContrast / count)) * centerPrior;
          if (score > bestScore) {
            bestScore = score;
            bestY = y0;
            bestRoll = rollDeg;
          }
        }
      }
    }
    return { y_px: Math.round(bestY * 10) / 10, roll_deg: bestRoll };
  }

  function computeCameraYawSeries(totalFrames, yawKeyframes) {
    const yaws = new Float32Array(totalFrames + 1);
    if (!yawKeyframes || !yawKeyframes.length) return yaws;
    const sorted = yawKeyframes.slice().sort((a, b) => a.start_frame - b.start_frame);
    let curYaw = 0.0;
    let fCursor = 1;
    for (const kf of sorted) {
      const s = clamp(Math.round(kf.start_frame), 1, totalFrames);
      const e = clamp(Math.max(s, Math.round(kf.end_frame)), 1, totalFrames);
      const targetYaw = Number(kf.to_deg) || 0.0;
      for (let f = fCursor; f < s; f++) yaws[f] = curYaw;
      const span = Math.max(1, e - s);
      for (let f = s; f <= e; f++) {
        const rawT = e === s ? 1.0 : (f - s) / span;
        const t = kf.interp === 'ease' ? smoothstep(rawT) : rawT;
        yaws[f] = curYaw + (targetYaw - curYaw) * t;
      }
      curYaw = targetYaw;
      fCursor = e + 1;
    }
    for (let f = fCursor; f <= totalFrames; f++) yaws[f] = curYaw;
    return yaws;
  }

  function getViewAtFrame(viewSegments, frame) {
    if (!viewSegments || !viewSegments.length) return 'first_person';
    for (const seg of viewSegments) {
      if (frame >= seg.start_frame && frame <= seg.end_frame) return seg.view;
    }
    return viewSegments[viewSegments.length - 1].view || 'first_person';
  }

  function autoDetectViewSegments(totalFrames, meTargetFrameMap) {
    if (!meTargetFrameMap) {
      return [{ view: 'first_person', start_frame: 1, end_frame: totalFrames }];
    }
    const raw = [];
    for (let f = 1; f <= totalFrames; f++) {
      const m = meTargetFrameMap[f];
      const vis = Boolean(m && m.visible);
      raw.push(vis ? 'third_person' : 'first_person');
    }
    // 5프레임 이하의 짧은 깜빡임 노이즈 제거
    const cleaned = raw.slice();
    let i = 0;
    while (i < cleaned.length) {
      let j = i;
      while (j < cleaned.length && cleaned[j] === cleaned[i]) j++;
      if (j - i <= 4 && i > 0 && j < cleaned.length && cleaned[i - 1] === cleaned[j]) {
        for (let k = i; k < j; k++) cleaned[k] = cleaned[i - 1];
      }
      i = j;
    }
    const segs = [];
    let start = 1;
    let cur = cleaned[0] || 'first_person';
    for (let f = 2; f <= totalFrames; f++) {
      if (cleaned[f - 1] !== cur) {
        segs.push({ view: cur, start_frame: start, end_frame: f - 1 });
        cur = cleaned[f - 1];
        start = f;
      }
    }
    segs.push({ view: cur, start_frame: start, end_frame: totalFrames });
    return segs;
  }

  // ===========================================================================
  // 3. 대상 2D 관측치 병합 · 불확실 구간 판정 · 3D 장면 동선 계산
  // ===========================================================================
  function extractTarget2DObservations(target, project) {
    const totalFrames = Math.max(1, Number(project.video.frames) || 1);
    const confThresh = Number(project.oral_values.confidence_threshold ?? 0.5);
    const excludeEdges = Boolean(target.exclude_edges);
    const refPoint = target.ref_point || (target.kind === 'ground' ? 'bbox_bottom_center' : 'bbox_center');
    const rawFrames = target.raw_frames || {};
    const manualKfs = (target.manual_keyframes || []).slice().sort((a, b) => a.frame - b.frame);
    const ignoredSet = new Set(target.ignored_uncertain || []);

    const obs = new Array(totalFrames + 1);

    // 1) SAM 2 원시 프레임 데이터 배치 (표본 간격 stride 사이 프레임 보간 지원)
    const samFrameNums = Object.keys(rawFrames).map(Number).filter(f => f >= 1 && f <= totalFrames).sort((a, b) => a - b);
    const stride = Math.max(1, Number(target.sam_stride) || 1);

    for (let f = 1; f <= totalFrames; f++) {
      obs[f] = {
        frame: f,
        visible: false,
        uncertain: false,
        uncertainReason: '',
        overridden: false,
        x_px: null,
        y_px: null,
        bbox_x: null,
        bbox_y: null,
        bbox_w: null,
        bbox_h: null,
        confidence: 0,
        edges: ''
      };
    }

    const evalSamItem = (r) => {
      const hasArea = Number(r.area) > 0 && r.bbox_w > 0 && r.bbox_h > 0;
      const conf = Number(r.confidence ?? (hasArea ? 1 : 0));
      const edges = String(r.edges || '');
      const lowConf = hasArea && conf < confThresh;
      const onEdge = hasArea && excludeEdges && edges.length > 0;
      const visible = hasArea && !onEdge && conf >= confThresh * 0.65;
      const rx = r.bbox_x + r.bbox_w / 2.0;
      const ry = refPoint === 'bbox_bottom_center' ? (r.bbox_y + r.bbox_h) : (r.bbox_y + r.bbox_h / 2.0);
      return {
        visible,
        uncertain: lowConf || onEdge,
        uncertainReason: onEdge ? `화면 가장자리(${edges})` : (lowConf ? `낮은 신뢰도(${conf.toFixed(2)})` : ''),
        x_px: hasArea ? rx : null,
        y_px: hasArea ? ry : null,
        bbox_x: r.bbox_x,
        bbox_y: r.bbox_y,
        bbox_w: r.bbox_w,
        bbox_h: r.bbox_h,
        confidence: conf,
        edges
      };
    };

    for (let idx = 0; idx < samFrameNums.length; idx++) {
      const fA = samFrameNums[idx];
      const evA = evalSamItem(rawFrames[fA]);
      Object.assign(obs[fA], evA);

      if (stride > 1 && idx + 1 < samFrameNums.length) {
        const fB = samFrameNums[idx + 1];
        if (fB - fA <= stride * 2) {
          const evB = evalSamItem(rawFrames[fB]);
          if (evA.visible && evB.visible && evA.x_px !== null && evB.x_px !== null) {
            for (let f = fA + 1; f < fB; f++) {
              const t = (f - fA) / (fB - fA);
              obs[f] = {
                frame: f,
                visible: true,
                uncertain: evA.uncertain || evB.uncertain,
                uncertainReason: evA.uncertainReason || evB.uncertainReason,
                overridden: false,
                x_px: evA.x_px + t * (evB.x_px - evA.x_px),
                y_px: evA.y_px + t * (evB.y_px - evA.y_px),
                bbox_x: evA.bbox_x + t * (evB.bbox_x - evA.bbox_x),
                bbox_y: evA.bbox_y + t * (evB.bbox_y - evA.bbox_y),
                bbox_w: evA.bbox_w + t * (evB.bbox_w - evA.bbox_w),
                bbox_h: evA.bbox_h + t * (evB.bbox_h - evA.bbox_h),
                confidence: evA.confidence + t * (evB.confidence - evA.confidence),
                edges: ''
              };
            }
          }
        }
      }
    }

    // 급격한 화면 점프 검출
    let prevVis = null;
    const jumpLimit = Math.hypot(project.video.width_px || 1280, project.video.height_px || 720) * 0.22;
    for (let f = 1; f <= totalFrames; f++) {
      if (obs[f].visible && obs[f].x_px !== null) {
        if (prevVis && f - prevVis.frame <= 3) {
          const distPx = Math.hypot(obs[f].x_px - prevVis.x_px, obs[f].y_px - prevVis.y_px);
          if (distPx > jumpLimit) {
            obs[f].uncertain = true;
            obs[f].uncertainReason = obs[f].uncertainReason || '급격한 위치 점프';
          }
        }
        prevVis = obs[f];
      }
    }

    // 2) 수동 키프레임 적용 (수동 동선 모드이거나 불확실 구간 덮어쓰기)
    if (manualKfs.length > 0) {
      if (target.track_tool === 'keyframe' || samFrameNums.length === 0) {
        for (let i = 0; i < manualKfs.length; i++) {
          const a = manualKfs[i];
          if (a.frame >= 1 && a.frame <= totalFrames) {
            obs[a.frame] = Object.assign(obs[a.frame], {
              visible: a.visible !== false,
              uncertain: false,
              overridden: true,
              x_px: a.x,
              y_px: a.y,
              bbox_w: a.bbox_w || obs[a.frame].bbox_w || 60,
              bbox_h: a.bbox_h || obs[a.frame].bbox_h || 60,
              manual_dist_m: a.distance_m || null,
              confidence: 1.0
            });
          }
          if (i + 1 < manualKfs.length) {
            const b = manualKfs[i + 1];
            if (a.visible !== false && b.visible !== false) {
              for (let f = Math.max(1, a.frame + 1); f < Math.min(totalFrames + 1, b.frame); f++) {
                const t = (f - a.frame) / (b.frame - a.frame);
                obs[f] = Object.assign(obs[f], {
                  visible: true,
                  uncertain: false,
                  overridden: true,
                  x_px: a.x + t * (b.x - a.x),
                  y_px: a.y + t * (b.y - a.y),
                  bbox_w: (a.bbox_w || 60) + t * ((b.bbox_w || 60) - (a.bbox_w || 60)),
                  bbox_h: (a.bbox_h || 60) + t * ((b.bbox_h || 60) - (a.bbox_h || 60)),
                  manual_dist_m: (a.distance_m && b.distance_m) ? (a.distance_m + t * (b.distance_m - a.distance_m)) : null,
                  confidence: 1.0
                });
              }
            }
          }
        }
      } else {
        // SAM 2 위에 수동 덮어쓰기 구간(override_spans 또는 인접 수동 키프레임 쌍) 반영
        for (let i = 0; i < manualKfs.length; i++) {
          const kf = manualKfs[i];
          if (kf.frame >= 1 && kf.frame <= totalFrames) {
            obs[kf.frame].visible = kf.visible !== false;
            obs[kf.frame].x_px = kf.x;
            obs[kf.frame].y_px = kf.y;
            obs[kf.frame].uncertain = false;
            obs[kf.frame].overridden = true;
            if (kf.distance_m) obs[kf.frame].manual_dist_m = kf.distance_m;
          }
          if (i + 1 < manualKfs.length && kf.span_pair && manualKfs[i + 1].span_pair === kf.span_pair) {
            const next = manualKfs[i + 1];
            for (let f = kf.frame + 1; f < next.frame; f++) {
              if (f >= 1 && f <= totalFrames) {
                const t = (f - kf.frame) / (next.frame - kf.frame);
                obs[f].visible = kf.visible !== false && next.visible !== false;
                obs[f].x_px = kf.x + t * (next.x - kf.x);
                obs[f].y_px = kf.y + t * (next.y - kf.y);
                obs[f].bbox_w = obs[f].bbox_w || obs[kf.frame].bbox_w || 60;
                obs[f].bbox_h = obs[f].bbox_h || obs[kf.frame].bbox_h || 60;
                obs[f].uncertain = false;
                obs[f].overridden = true;
              }
            }
          }
        }
      }
    }

    for (let f = 1; f <= totalFrames; f++) {
      if (ignoredSet.has(f)) obs[f].uncertain = false;
    }

    // 불확실 연속 구간 목록 생성
    const uncertainSpans = [];
    let uStart = null;
    let uReason = '';
    for (let f = 1; f <= totalFrames; f++) {
      if (obs[f].uncertain) {
        if (uStart === null) { uStart = f; uReason = obs[f].uncertainReason; }
      } else if (uStart !== null) {
        uncertainSpans.push({ start_frame: uStart, end_frame: f - 1, reason: uReason });
        uStart = null;
      }
    }
    if (uStart !== null) uncertainSpans.push({ start_frame: uStart, end_frame: totalFrames, reason: uReason });

    return { obs, uncertainSpans };
  }

  function smoothSeries(values, validMask, windowSize) {
    const w = Math.floor(Number(windowSize) || 0);
    if (w <= 1) return values.slice();
    const half = Math.floor(w / 2);
    const out = values.slice();
    for (let i = 1; i < values.length; i++) {
      if (!validMask[i]) continue;
      let sum = 0, cnt = 0;
      for (let k = Math.max(1, i - half); k <= Math.min(values.length - 1, i + half); k++) {
        if (validMask[k] && Number.isFinite(values[k])) {
          sum += values[k];
          cnt++;
        }
      }
      if (cnt > 0) out[i] = sum / cnt;
    }
    return out;
  }

  /**
   * 프로젝트 전체 장면 그래프 계산:
   * 지평선 → 시점 → 카메라 높이 → 카메라 회전/위치 → 각 대상의 3D 장면 좌표(화면 밖 보간·연장 포함) → 청취자 기준 상대 방향/거리
   */
  function computeSceneGraph(project) {
    const totalFrames = Math.max(1, Number(project.video.frames) || 1);
    const fps = Math.max(1, Number(project.video.fps) || 30);
    const intrinsics = computeIntrinsics(project.video);
    const yawSeries = computeCameraYawSeries(totalFrames, project.camera.yaw_keyframes);

    // 1) 모든 대상의 2D 관측치 먼저 추출
    const targetObsMap = {};
    for (const t of project.targets) {
      targetObsMap[t.id] = extractTarget2DObservations(t, project);
    }

    // 2) 프레임별 지평선 & 카메라 높이 & 카메라 위치
    const horizons = new Array(totalFrames + 1);
    const camHeights = new Float32Array(totalFrames + 1);
    const camPos = new Array(totalFrames + 1);
    const fpHeight = Math.max(0.2, Number(project.camera.height.first_person_m ?? project.oral_values.eye_height_m) || 1.6);
    const tpInputHeight = Math.max(0.2, Number(project.camera.height.third_person_input_m) || 2.5);
    const personH = Math.max(0.5, Number(project.oral_values.person_height_m) || 1.7);
    const refPersonId = project.camera.height.height_person_target || project.camera.me_target;
    const refPersonObs = refPersonId && targetObsMap[refPersonId] ? targetObsMap[refPersonId].obs : null;

    let lastTpHeight = tpInputHeight;
    for (let f = 1; f <= totalFrames; f++) {
      horizons[f] = computeHorizonAtFrame(project, f, intrinsics);
      const view = getViewAtFrame(project.camera.view_segments, f);
      if (view === 'first_person') {
        camHeights[f] = fpHeight;
      } else {
        if (project.camera.height.third_person_method === 'from_person' && refPersonObs && refPersonObs[f] && refPersonObs[f].visible && refPersonObs[f].bbox_h > 4) {
          const ob = refPersonObs[f];
          const feetY = (ob.bbox_y ?? (ob.y_px - ob.bbox_h)) + ob.bbox_h;
          const headY = ob.bbox_y ?? (feetY - ob.bbox_h);
          const denom = Math.max(4, feetY - headY);
          const ratio = (feetY - horizons[f].yPx) / denom;
          lastTpHeight = clamp(personH * ratio, 0.4, 25.0);
        } else if (project.camera.height.third_person_method === 'input') {
          lastTpHeight = tpInputHeight;
        }
        camHeights[f] = view === 'transition' ? 0.5 * (fpHeight + lastTpHeight) : lastTpHeight;
      }

      const pkfs = project.camera.pos_keyframes || [];
      const cx = interpolateKeyedScalar(pkfs, f, it => it.x_m, 0.0);
      const cy = interpolateKeyedScalar(pkfs, f, it => it.y_m, 0.0);
      const cz = pkfs.length ? interpolateKeyedScalar(pkfs, f, it => it.z_m ?? camHeights[f], camHeights[f]) : camHeights[f];
      camPos[f] = [cx, cy, cz];
    }

    // 3) 각 대상의 3D 장면 좌표 계산
    const targetTracks = {};
    for (const target of project.targets) {
      const { obs, uncertainSpans } = targetObsMap[target.id];
      const xs = new Float64Array(totalFrames + 1);
      const ys = new Float64Array(totalFrames + 1);
      const zs = new Float64Array(totalFrames + 1);
      const valid = new Uint8Array(totalFrames + 1);
      const estimated = new Uint8Array(totalFrames + 1);

      const defaultSoundH = target.sound_height_m !== null && target.sound_height_m !== undefined
        ? Number(target.sound_height_m)
        : (target.kind === 'ground' ? (Number(project.oral_values.sound_height_m) || 1.2) : 5.0);

      for (let f = 1; f <= totalFrames; f++) {
        const ob = obs[f];
        if (!ob.visible || ob.x_px === null || ob.y_px === null) continue;

        const hz = horizons[f];
        const { azCam, elCam } = pixelToCameraAngles(ob.x_px, ob.y_px, intrinsics, hz.rollDeg);
        const worldAz = wrapDeg(azCam + yawSeries[f]);
        const worldEl = clamp(elCam + hz.pitchDeg, -89.0, 89.0);
        const cam = camPos[f];

        let horizDist = 2.0;
        let worldZ = defaultSoundH;

        if (ob.manual_dist_m && ob.manual_dist_m > 0) {
          const d3 = ob.manual_dist_m;
          horizDist = d3 * Math.cos(worldEl * DEG2RAD);
          worldZ = Math.max(0, cam[2] + d3 * Math.sin(worldEl * DEG2RAD));
        } else if (target.distance_method === 'known_size') {
          const knownMap = project.oral_values.known_sizes_m || {};
          const realSize = Math.max(0.05, Number(knownMap[target.size_key]) || Number(project.oral_values.person_height_m) || 1.7);
          const bw = ob.bbox_w || 50, bh = ob.bbox_h || 50;
          const pxSize = target.size_axis === 'width' ? bw : (target.size_axis === 'height' ? bh : Math.max(bw, bh));
          const d3 = clamp((realSize * intrinsics.focalPx) / Math.max(2.0, pxSize), 0.25, 500.0);
          horizDist = d3 * Math.cos(worldEl * DEG2RAD);
          worldZ = target.kind === 'ground' ? defaultSoundH : Math.max(0, cam[2] + d3 * Math.sin(worldEl * DEG2RAD));
        } else {
          // ground_contact: 접점 기준 하향각으로 수평거리 계산
          const downAngleDeg = Math.max(0.6, -worldEl);
          horizDist = clamp(cam[2] / Math.tan(downAngleDeg * DEG2RAD), 0.3, 300.0);
          worldZ = defaultSoundH;
        }

        const azRad = worldAz * DEG2RAD;
        xs[f] = cam[0] + horizDist * Math.sin(azRad);
        ys[f] = cam[1] + horizDist * Math.cos(azRad);
        zs[f] = worldZ;
        valid[f] = 1;
      }

      // 평활화 (보이는 구간 내 노이즈 억제)
      const smoothWin = Number(target.smooth_window) || 0;
      const sXs = smoothWin > 1 ? smoothSeries(Array.from(xs), valid, smoothWin) : Array.from(xs);
      const sYs = smoothWin > 1 ? smoothSeries(Array.from(ys), valid, smoothWin) : Array.from(ys);
      const sZs = smoothWin > 1 ? smoothSeries(Array.from(zs), valid, smoothWin) : Array.from(zs);

      // 화면 밖 구간 잇기 + 경유점(waypoints) 반영
      const waypoints = (target.waypoints || []).slice().sort((a, b) => a.frame - b.frame);
      const bridgeGaps = target.bridge_gaps !== false; // 기본 활성화 가능 (또는 경유점이 있을 때)

      // 앵커 포인트 수집 (보이는 프레임 + 경유점)
      let firstVis = -1, lastVis = -1;
      for (let f = 1; f <= totalFrames; f++) {
        if (valid[f]) {
          if (firstVis < 0) firstVis = f;
          lastVis = f;
        }
      }

      if (firstVis > 0) {
        // 내부 빈 구간 탐색
        let f = firstVis;
        while (f <= lastVis) {
          if (valid[f]) { f++; continue; }
          let gapStart = f;
          while (f <= lastVis && !valid[f]) f++;
          let gapEnd = f - 1;
          const prevF = gapStart - 1;
          const nextF = f <= lastVis ? f : -1;
          const gapWps = waypoints.filter(w => w.frame >= gapStart && w.frame <= gapEnd);

          if (nextF > 0 && (bridgeGaps || gapWps.length > 0)) {
            const nodes = [
              { frame: prevF, x: sXs[prevF], y: sYs[prevF], z: sZs[prevF] },
              ...gapWps.map(w => ({ frame: w.frame, x: w.x_m, y: w.y_m, z: w.z_m ?? sZs[prevF] })),
              { frame: nextF, x: sXs[nextF], y: sYs[nextF], z: sZs[nextF] }
            ];
            for (let n = 0; n < nodes.length - 1; n++) {
              const A = nodes[n], B = nodes[n + 1];
              for (let k = A.frame + 1; k < B.frame + (n === nodes.length - 2 ? 0 : 1); k++) {
                if (k >= gapStart && k <= gapEnd) {
                  const t = (k - A.frame) / Math.max(1, B.frame - A.frame);
                  sXs[k] = A.x + t * (B.x - A.x);
                  sYs[k] = A.y + t * (B.y - A.y);
                  sZs[k] = A.z + t * (B.z - A.z);
                  estimated[k] = 1;
                }
              }
            }
          }
        }

        // 처음 연장 (extend_start) & 앞쪽 경유점
        const earlyWps = waypoints.filter(w => w.frame < firstVis);
        if (earlyWps.length > 0) {
          const nodes = [
            ...earlyWps.map(w => ({ frame: w.frame, x: w.x_m, y: w.y_m, z: w.z_m ?? sZs[firstVis] })),
            { frame: firstVis, x: sXs[firstVis], y: sYs[firstVis], z: sZs[firstVis] }
          ];
          for (let n = 0; n < nodes.length - 1; n++) {
            const A = nodes[n], B = nodes[n + 1];
            for (let k = A.frame; k < B.frame; k++) {
              const t = (k - A.frame) / Math.max(1, B.frame - A.frame);
              sXs[k] = A.x + t * (B.x - A.x);
              sYs[k] = A.y + t * (B.y - A.y);
              sZs[k] = A.z + t * (B.z - A.z);
              estimated[k] = 1;
            }
          }
        } else if (target.extend_start === 'hold' && firstVis > 1) {
          for (let k = 1; k < firstVis; k++) {
            sXs[k] = sXs[firstVis]; sYs[k] = sYs[firstVis]; sZs[k] = sZs[firstVis];
            estimated[k] = 1;
          }
        } else if (target.extend_start === 'linear' && firstVis > 1) {
          const ref2 = Math.min(totalFrames, firstVis + 5);
          const vx = valid[ref2] ? (sXs[ref2] - sXs[firstVis]) / Math.max(1, ref2 - firstVis) : 0;
          const vy = valid[ref2] ? (sYs[ref2] - sYs[firstVis]) / Math.max(1, ref2 - firstVis) : 0;
          for (let k = 1; k < firstVis; k++) {
            sXs[k] = sXs[firstVis] - vx * (firstVis - k);
            sYs[k] = sYs[firstVis] - vy * (firstVis - k);
            sZs[k] = sZs[firstVis];
            estimated[k] = 1;
          }
        }

        // 끝 연장 (extend_end) & 뒤쪽 경유점
        const lateWps = waypoints.filter(w => w.frame > lastVis);
        if (lateWps.length > 0) {
          const nodes = [
            { frame: lastVis, x: sXs[lastVis], y: sYs[lastVis], z: sZs[lastVis] },
            ...lateWps.map(w => ({ frame: w.frame, x: w.x_m, y: w.y_m, z: w.z_m ?? sZs[lastVis] }))
          ];
          for (let n = 0; n < nodes.length - 1; n++) {
            const A = nodes[n], B = nodes[n + 1];
            for (let k = A.frame + 1; k <= B.frame; k++) {
              const t = (k - A.frame) / Math.max(1, B.frame - A.frame);
              sXs[k] = A.x + t * (B.x - A.x);
              sYs[k] = A.y + t * (B.y - A.y);
              sZs[k] = A.z + t * (B.z - A.z);
              estimated[k] = 1;
            }
          }
        } else if (target.extend_end === 'hold' && lastVis < totalFrames) {
          for (let k = lastVis + 1; k <= totalFrames; k++) {
            sXs[k] = sXs[lastVis]; sYs[k] = sYs[lastVis]; sZs[k] = sZs[lastVis];
            estimated[k] = 1;
          }
        } else if (target.extend_end === 'linear' && lastVis < totalFrames) {
          const ref1 = Math.max(1, lastVis - 5);
          const vx = valid[ref1] ? (sXs[lastVis] - sXs[ref1]) / Math.max(1, lastVis - ref1) : 0;
          const vy = valid[ref1] ? (sYs[lastVis] - sYs[ref1]) / Math.max(1, lastVis - ref1) : 0;
          for (let k = lastVis + 1; k <= totalFrames; k++) {
            sXs[k] = sXs[lastVis] + vx * (k - lastVis);
            sYs[k] = sYs[lastVis] + vy * (k - lastVis);
            sZs[k] = sZs[lastVis];
            estimated[k] = 1;
          }
        }
      }

      targetTracks[target.id] = {
        id: target.id,
        obs,
        uncertainSpans,
        sceneX: sXs,
        sceneY: sYs,
        sceneZ: sZs,
        valid,
        estimated
      };
    }

    // 4) 프레임별 청취자(Listener) 위치 및 정면 방향 결정 (camera vs me)
    const listenerPos = new Array(totalFrames + 1);
    const listenerYaw = new Float32Array(totalFrames + 1);
    const meTrack = project.camera.me_target ? targetTracks[project.camera.me_target] : null;
    const meEarH = Number(project.listener.me_ear_height_m ?? project.oral_values.eye_height_m) || 1.6;
    const meFacing = Number(project.listener.me_facing_deg) || 0.0;

    for (let f = 1; f <= totalFrames; f++) {
      if (project.listener.reference === 'me' && meTrack && (meTrack.valid[f] || meTrack.estimated[f])) {
        listenerPos[f] = [meTrack.sceneX[f], meTrack.sceneY[f], meEarH];
        listenerYaw[f] = meFacing;
      } else {
        listenerPos[f] = camPos[f];
        listenerYaw[f] = yawSeries[f];
      }
    }

    // 5) 청취자 기준 각 대상의 상대 방위각·고도각·거리 + 최근접 거리 요약
    for (const target of project.targets) {
      const tr = targetTracks[target.id];
      const frames = new Array(totalFrames + 1);
      let minDist = Infinity;
      let minDistFrame = null;
      let unbridgedGaps = 0;

      // 이어지지 않은 화면 밖 구간 확인
      let inVis = false, hadVis = false, inGap = false;
      for (let f = 1; f <= totalFrames; f++) {
        const active = Boolean(tr.valid[f] || tr.estimated[f]);
        if (active) {
          if (inGap && hadVis) unbridgedGaps++;
          hadVis = true;
          inGap = false;
          inVis = true;
        } else if (inVis) {
          inGap = true;
          inVis = false;
        }

        const lp = listenerPos[f];
        const lyaw = listenerYaw[f];
        if (active) {
          const dx = tr.sceneX[f] - lp[0];
          const dy = tr.sceneY[f] - lp[1];
          const dz = tr.sceneZ[f] - lp[2];
          const horiz = Math.hypot(dx, dy);
          const dist3d = Math.max(0.05, Math.hypot(horiz, dz));
          const worldAz = Math.atan2(dx, dy) * RAD2DEG;
          const relAz = wrapDeg(worldAz - lyaw);
          const relEl = Math.atan2(dz, Math.max(1e-4, horiz)) * RAD2DEG;
          if (dist3d < minDist) {
            minDist = dist3d;
            minDistFrame = f;
          }
          frames[f] = {
            frame: f,
            time_s: (f - 1) / fps,
            active: true,
            visible: Boolean(tr.valid[f]),
            estimated: Boolean(tr.estimated[f]),
            uncertain: Boolean(tr.obs[f].uncertain),
            azimuth_deg: relAz,
            elevation_deg: relEl,
            distance_m: dist3d,
            scene_xyz: [tr.sceneX[f], tr.sceneY[f], tr.sceneZ[f]],
            x_px: tr.obs[f].x_px,
            y_px: tr.obs[f].y_px,
            confidence: tr.obs[f].confidence
          };
        } else {
          frames[f] = {
            frame: f,
            time_s: (f - 1) / fps,
            active: false,
            visible: false,
            estimated: false,
            uncertain: false,
            azimuth_deg: 0,
            elevation_deg: 0,
            distance_m: 2.0,
            scene_xyz: null,
            x_px: null,
            y_px: null,
            confidence: 0
          };
        }
      }

      tr.frames = frames;
      tr.nearest = minDistFrame !== null ? { frame: minDistFrame, distance_m: Math.round(minDist * 100) / 100 } : null;
      tr.unbridgedGaps = unbridgedGaps;
    }

    // 6) 고정 음원의 청취자 기준 프레임별 상대 방향/거리
    const fixedTracks = {};
    for (const fx of project.fixed_sources) {
      const xyz = fx.scene_xyz_m || [0, 2, 1.2];
      const frames = new Array(totalFrames + 1);
      for (let f = 1; f <= totalFrames; f++) {
        const lp = listenerPos[f];
        const lyaw = listenerYaw[f];
        const dx = xyz[0] - lp[0];
        const dy = xyz[1] - lp[1];
        const dz = xyz[2] - lp[2];
        const horiz = Math.hypot(dx, dy);
        const dist3d = Math.max(0.05, Math.hypot(horiz, dz));
        const worldAz = Math.atan2(dx, dy) * RAD2DEG;
        frames[f] = {
          frame: f,
          time_s: (f - 1) / fps,
          active: true,
          visible: true,
          estimated: false,
          azimuth_deg: wrapDeg(worldAz - lyaw),
          elevation_deg: Math.atan2(dz, Math.max(1e-4, horiz)) * RAD2DEG,
          distance_m: dist3d,
          scene_xyz: xyz
        };
      }
      fixedTracks[fx.id] = { id: fx.id, frames, scene_xyz: xyz };
    }

    return {
      totalFrames,
      fps,
      intrinsics,
      horizons,
      camHeights,
      camPos,
      yawSeries,
      listenerPos,
      listenerYaw,
      targetTracks,
      fixedTracks
    };
  }

  /**
   * 영상에서 땅(지면 z=0)을 클릭했을 때 3D 장면 좌표 [x, y, 0] 역산
   */
  function projectVideoGroundClick(pxX, pxY, frame, sceneGraph) {
    const f = clamp(Math.round(frame), 1, sceneGraph.totalFrames);
    const hz = sceneGraph.horizons[f];
    const cam = sceneGraph.camPos[f];
    const { azCam, elCam } = pixelToCameraAngles(pxX, pxY, sceneGraph.intrinsics, hz.rollDeg);
    const worldAz = wrapDeg(azCam + sceneGraph.yawSeries[f]);
    const worldEl = elCam + hz.pitchDeg;
    const downDeg = Math.max(1.0, -worldEl);
    const horizDist = clamp(cam[2] / Math.tan(downDeg * DEG2RAD), 0.4, 150.0);
    const x = Math.round((cam[0] + horizDist * Math.sin(worldAz * DEG2RAD)) * 100) / 100;
    const y = Math.round((cam[1] + horizDist * Math.cos(worldAz * DEG2RAD)) * 100) / 100;
    return [x, y, 0.0];
  }

  // ===========================================================================
  // 4. 공간 음향 패닝 · 고도 확산 · 거리 단서 · FOA 디코딩 계산
  // ===========================================================================
  function computePairwiseVbap2D(azimuthDeg) {
    const az = wrapDeg(azimuthDeg);
    const g = [0, 0, 0, 0];
    let sp1, sp2, th1, th2, th;
    if (az >= -30.0 && az <= 30.0) {
      sp1 = 0; sp2 = 1; th1 = -30.0; th2 = 30.0; th = az;
    } else if (az > 30.0 && az <= 135.0) {
      sp1 = 1; sp2 = 3; th1 = 30.0; th2 = 135.0; th = az;
    } else if (az >= -135.0 && az < -30.0) {
      sp1 = 2; sp2 = 0; th1 = -135.0; th2 = -30.0; th = az;
    } else {
      sp1 = 3; sp2 = 2; th1 = 135.0; th2 = 225.0; th = az >= 0 ? az : az + 360.0;
    }
    const th1R = th1 * DEG2RAD, th2R = th2 * DEG2RAD, thR = th * DEG2RAD;
    const denom = Math.sin(th2R - th1R);
    let g1 = Math.max(0, Math.sin(th2R - thR) / denom);
    let g2 = Math.max(0, Math.sin(thR - th1R) / denom);
    const norm = Math.hypot(g1, g2);
    if (norm > 1e-6) { g1 /= norm; g2 /= norm; }
    g[sp1] = g1;
    g[sp2] = g2;
    return g;
  }

  function computeObjectSpeakerGains(params) {
    const {
      azimuthDeg = 0,
      elevationDeg = 0,
      distanceM = 2.0,
      rotationOffsetDeg = 0,
      elevationScale = 1.0,
      frontBackBiasDb = 0.0,
      applyDistanceCues = true,
      applyNearRule = true,
      nearThresholdM = 1.5,
      attenRefM = 2.0,
      attenK = 1.0,
      trackGainLinear = 1.0
    } = params;

    const az = wrapDeg(azimuthDeg + rotationOffsetDeg);
    const el = clamp(elevationDeg * elevationScale, -90.0, 90.0);
    const dist = Math.max(0.05, distanceM);

    // 1) 2D 쌍별 VBAP
    const g2d = computePairwiseVbap2D(az);

    // 2) 고도 퍼뜨리기 (상향 고도가 커질수록 4채널 균등 에너지 분배)
    const elSpread = clamp(Math.sin(Math.max(0, el) * DEG2RAD), 0, 1);
    const gEl = [0, 0, 0, 0];
    let normSq = 0;
    for (let i = 0; i < 4; i++) {
      gEl[i] = (1 - elSpread) * g2d[i] + elSpread * 0.5;
      normSq += gEl[i] * gEl[i];
    }
    const norm = Math.sqrt(normSq) || 1;
    for (let i = 0; i < 4; i++) gEl[i] /= norm;

    // 3) 가까운 대상 규칙 (near_threshold_m 안쪽이면 4스피커 고르게 퍼뜨림)
    if (applyNearRule && nearThresholdM > 0 && dist < nearThresholdM) {
      const nearBlend = 1.0 - clamp(dist / nearThresholdM, 0, 1);
      let nSq = 0;
      for (let i = 0; i < 4; i++) {
        gEl[i] = (1 - nearBlend) * gEl[i] + nearBlend * 0.5;
        nSq += gEl[i] * gEl[i];
      }
      const nNorm = Math.sqrt(nSq) || 1;
      for (let i = 0; i < 4; i++) gEl[i] /= nNorm;
    }

    // 4) 거리 감쇠: atten_db = -20 * k * log10(max(d, ref) / ref)
    let distGain = 1.0;
    let lowpassHz = 20000;
    let reverbSend = 0.0;
    if (applyDistanceCues) {
      const ref = Math.max(0.1, attenRefM || 2.0);
      const k = Math.max(0, attenK ?? 1.0);
      if (dist > ref && k > 0) {
        const attenDb = -20.0 * k * Math.log10(dist / ref);
        distGain = Math.max(0.005, Math.pow(10, attenDb / 20.0));
      }
      const excessDist = Math.max(0, dist - ref);
      lowpassHz = clamp(20000 * Math.exp(-0.032 * excessDist), 1200, 20000);
      reverbSend = clamp(0.05 + 0.35 * (1 - Math.exp(-0.06 * excessDist)), 0, 0.45);
    }

    // 5) 전후 밸런스 보정 및 트랙 게인
    const frontMult = Math.pow(10, frontBackBiasDb / 40.0);
    const rearMult = Math.pow(10, -frontBackBiasDb / 40.0);
    const mults = [frontMult, frontMult, rearMult, rearMult];

    const gains = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      gains[i] = gEl[i] * distGain * mults[i] * trackGainLinear;
    }

    return { gains, distGain, lowpassHz, reverbSend, az, el, dist };
  }

  /**
   * FOA AmbiX (ch0=W, ch1=Y, ch2=Z, ch3=X) → 회전 후 4채널 스피커(FL, FR, RL, RR) 디코딩 행렬 (4x4)
   */
  function computeFoaDecodeMatrix(yawDeg) {
    const rad = (Number(yawDeg) || 0) * DEG2RAD;
    const cPsi = Math.cos(rad), sPsi = Math.sin(rad);
    // 스피커마다 [wWeight, yWeight, zWeight, xWeight] 반환
    return SPEAKER_AZIMUTHS.map(spkAz => {
      const th = spkAz * DEG2RAD;
      const cTh = Math.cos(th), sTh = Math.sin(th);
      // X' = X cos(psi) - Y sin(psi), Y' = Y cos(psi) + X sin(psi)
      // S = 0.5 * (W + X' cos(th) - Y' sin(th))
      const wW = 0.5;
      const xW = 0.5 * (cPsi * cTh - sPsi * sTh);
      const yW = 0.5 * (-sPsi * cTh - cPsi * sTh);
      const zW = 0.0;
      return [wW, yW, zW, xW];
    });
  }

  function computeChannelRuleGains(rule, numInputChannels) {
    // 각 입력 채널이 [FL, FR, RL, RR]로 가는 가중치 행렬 반환
    if (rule === 'DX_center') {
      const s = 0.7071 / Math.max(1, numInputChannels);
      return Array.from({ length: numInputChannels }, () => [s, s, 0, 0]);
    }
    if (rule === 'FX_front') {
      if (numInputChannels >= 2) {
        return [[1, 0, 0, 0], [0, 1, 0, 0], ...Array.from({ length: numInputChannels - 2 }, () => [0.5, 0.5, 0, 0])];
      }
      return [[0.7071, 0.7071, 0, 0]];
    }
    if (rule === 'MX_quad') {
      if (numInputChannels === 1) return [[0.5, 0.5, 0.35, 0.35]];
      if (numInputChannels === 2) return [[0.85, 0, 0.5, 0], [0, 0.85, 0, 0.5]];
      return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    }
    if (['CH1', 'CH2', 'CH3', 'CH4', '0', '1', '2', '3'].includes(String(rule))) {
      const ch = String(rule).startsWith('CH') ? Number(String(rule).slice(2)) - 1 : Number(rule);
      const row = [0, 0, 0, 0];
      row[clamp(ch, 0, 3)] = 1 / Math.max(1, numInputChannels);
      return Array.from({ length: numInputChannels }, () => row.slice());
    }
    // auto: 채널 순서 그대로
    return Array.from({ length: numInputChannels }, (_, c) => {
      const row = [0, 0, 0, 0];
      if (c < 4) row[c] = 1;
      return row;
    });
  }

  /**
   * 분류 질문 3개에 따른 전달 방식 추천
   */
  function recommendDeliveryFromQuestions(q, channelCount) {
    if (channelCount === 4) {
      return { type: 'FX', delivery: 'Scene', detail: 'FOA AmbiX 4채널 장면 음원 (Scene)', linkHint: 'foa_ambix' };
    }
    const diegetic = q && q.diegetic !== false;
    const needsPos = q && Boolean(q.needs_position);
    const distChanges = q && Boolean(q.distance_changes);
    if (!diegetic) {
      return { type: 'MX', delivery: 'Channel', detail: '비디제틱(배경음악/해설) → Channel (MX_quad / DX_center)', linkHint: 'MX_quad' };
    }
    if (!needsPos) {
      return { type: 'DX', delivery: 'Channel', detail: '장면 안 소리지만 위치 불필요 → Channel (DX_center)', linkHint: 'DX_center' };
    }
    if (!distChanges) {
      return { type: 'FX', delivery: 'Object', detail: '위치는 필요하나 거리 변화 없음 → Object (고정 음원)', linkHint: 'fixed' };
    }
    return { type: 'FX', delivery: 'Object', detail: '위치·거리가 함께 변함 → Object (대상 동선 + 거리 단서)', linkHint: 'target' };
  }

  // ===========================================================================
  // 5. 사전 점검 (Pre-flight Warnings) & 직렬화 (JSON, CSV, gain_log, WAV)
  // ===========================================================================
  function runPreflightCheck(project, sceneGraph, renderInfo) {
    const warnings = [];
    if (!project.video.file) {
      warnings.push({ level: 'warn', mode: 1, message: '영상이 열려 있지 않습니다 (기본 해상도/길이 사용 중).' });
    }
    const ov = project.oral_values;
    if (ov.person_height_m === null || ov.eye_height_m === null) {
      warnings.push({ level: 'warn', mode: 1, message: '필수 설정값(사람 키 또는 1인칭 카메라 높이)이 비어 있습니다.' });
    }

    for (const t of project.targets) {
      const tr = sceneGraph && sceneGraph.targetTracks[t.id];
      if (t.distance_method === 'known_size' && (!t.size_key || !(ov.known_sizes_m && ov.known_sizes_m[t.size_key] > 0))) {
        warnings.push({ level: 'error', mode: 3, message: `대상 '${t.id}': 기준 크기법을 선택했으나 유효한 대상 크기가 지정되지 않았습니다.` });
      }
      if (tr) {
        const hasAny = tr.frames.some(fr => fr && fr.active);
        if (!hasAny) {
          warnings.push({ level: 'warn', mode: 3, message: `대상 '${t.id}': 추적된 프레임이나 수동 키프레임이 없습니다.` });
        }
        if (tr.uncertainSpans && tr.uncertainSpans.length > 0) {
          warnings.push({ level: 'warn', mode: 3, message: `대상 '${t.id}': 미확인 불확실 구간이 ${tr.uncertainSpans.length}곳 있습니다.` });
        }
        if (tr.unbridgedGaps > 0) {
          warnings.push({ level: 'warn', mode: 4, message: `대상 '${t.id}': 화면 밖 구간 ${tr.unbridgedGaps}곳이 이어지지 않았습니다.` });
        }
      }
    }

    for (const s of project.sources) {
      if (!s._hasBuffer) {
        warnings.push({ level: 'error', mode: 5, message: `음원 '${s.id}' (${s.file || '미지정'}): 오디오 파일이 연결되지 않았습니다.` });
      }
      if (!s.start_frame || s.start_frame < 1) {
        warnings.push({ level: 'error', mode: 5, message: `음원 '${s.id}': 시작 프레임이 지정되지 않았습니다.` });
      }
      if (s.delivery === 'Object') {
        const link = s.link || {};
        const okTarget = link.target && project.targets.some(t => t.id === link.target);
        const okFixed = link.fixed && project.fixed_sources.some(fx => fx.id === link.fixed);
        const okCsv = Boolean(s._customPath);
        if (!okTarget && !okFixed && !okCsv) {
          warnings.push({ level: 'error', mode: 5, message: `음원 '${s.id}': Object 전달 방식인데 대상 동선이나 고정 위치에 연결되지 않았습니다.` });
        }
      }
    }

    if (renderInfo && renderInfo.peakBeforeLimit > 1.0) {
      warnings.push({
        level: 'warn',
        mode: 6,
        message: `합산 피크(${renderInfo.peakBeforeLimit.toFixed(2)})가 1.0을 넘어 클리핑 방지 감쇠(${renderInfo.limiterGain.toFixed(3)}x)가 자동 적용되었습니다.`
      });
    }

    return warnings;
  }

  /**
   * settings_format.md 규격(isad-session3-settings, version 1) JSON 직렬화
   */
  function serializeSettingsJson(project) {
    const pathCsvs = project.targets.map(t => t.path_csv || `${t.id}_path.csv`);
    const out = {
      format: 'isad-session3-settings',
      version: 1,
      video: {
        file: project.video.file || null,
        width_px: project.video.width_px ?? null,
        height_px: project.video.height_px ?? null,
        fps: project.video.fps ?? null,
        frames: project.video.frames ?? null,
        hfov_deg: project.video.hfov_deg ?? null
      },
      oral_values: {
        person_height_m: project.oral_values.person_height_m ?? null,
        eye_height_m: project.oral_values.eye_height_m ?? null,
        near_threshold_m: project.oral_values.near_threshold_m ?? null,
        atten_ref_m: project.oral_values.atten_ref_m ?? null,
        atten_k: project.oral_values.atten_k ?? 1.0,
        confidence_threshold: project.oral_values.confidence_threshold ?? null,
        known_sizes_m: deepClone(project.oral_values.known_sizes_m || {}),
        sound_height_m: project.oral_values.sound_height_m ?? null,
        turn_angle_deg: project.oral_values.turn_angle_deg ?? null
      },
      listener: {
        reference: project.listener.reference || 'camera',
        me_ear_height_m: project.listener.me_ear_height_m ?? null,
        me_facing_deg: project.listener.me_facing_deg ?? 0.0
      },
      camera: {
        me_target: project.camera.me_target || null,
        horizon: {
          method: project.camera.horizon.method || 'auto',
          pitch_input_deg: project.camera.horizon.pitch_input_deg ?? null,
          corrections: deepClone(project.camera.horizon.corrections || []),
          parallel_lines: deepClone(project.camera.horizon.parallel_lines || []),
          known_person: deepClone(project.camera.horizon.known_person || []),
          auto_profile: deepClone(project.camera.horizon.auto_profile || [])
        },
        view_segments: deepClone(project.camera.view_segments || []),
        height: {
          first_person_m: project.camera.height.first_person_m ?? null,
          third_person_method: project.camera.height.third_person_method || 'from_person',
          third_person_input_m: project.camera.height.third_person_input_m ?? null,
          height_person_target: project.camera.height.height_person_target || null
        },
        yaw_keyframes: deepClone(project.camera.yaw_keyframes || []),
        pos_keyframes: deepClone(project.camera.pos_keyframes || [])
      },
      targets: project.targets.map(t => ({
        id: t.id,
        kind: t.kind || 'air',
        ref_point: t.ref_point || (t.kind === 'ground' ? 'bbox_bottom_center' : 'bbox_center'),
        track_tool: t.track_tool || 'sam2',
        distance_method: t.distance_method || 'known_size',
        size_key: t.size_key || null,
        size_axis: t.size_axis || 'max',
        sound_height_m: t.sound_height_m ?? null,
        path_csv: t.path_csv || `${t.id}_path.csv`,
        studio_extra: {
          exclude_edges: Boolean(t.exclude_edges),
          smooth_window: Number(t.smooth_window) || 0,
          bridge_gaps: t.bridge_gaps !== false,
          extend_start: t.extend_start || 'none',
          extend_end: t.extend_end || 'none',
          sam_stride: t.sam_stride || 1,
          prompts: t.prompts || [],
          manual_keyframes: t.manual_keyframes || [],
          waypoints: t.waypoints || [],
          ignored_uncertain: t.ignored_uncertain || [],
          raw_frames: t.raw_frames || {}
        }
      })),
      fixed_sources: project.fixed_sources.map(fx => ({
        id: fx.id,
        from_target: fx.from_target || null,
        frame: fx.frame ?? null,
        scene_xyz_m: (fx.scene_xyz_m || [0, 2, 0]).map(v => Math.round(Number(v) * 1000) / 1000)
      })),
      sources: project.sources.map(s => ({
        id: s.id,
        file: s.file || '',
        type: s.type || 'FX',
        delivery: s.delivery || 'Object',
        link: deepClone(s.link || {}),
        start_frame: s.start_frame ?? 1,
        end_frame: s.end_frame ?? null,
        questions: deepClone(s.questions || { diegetic: true, needs_position: true, distance_changes: true }),
        distance_cues: s.distance_cues !== false,
        near_rule: s.near_rule !== false,
        note: s.note || '',
        gain_db: Number(s.gain_db) || 0.0,
        muted: Boolean(s.muted),
        solo: Boolean(s.solo)
      })),
      outputs: {
        wav_4ch: project.outputs.wav_4ch || 'mix_4ch.wav',
        video_mp4: project.outputs.video_mp4 || 'mix_video.mp4',
        gain_log_csv: project.outputs.gain_log_csv || 'gain_log.csv',
        path_csvs: pathCsvs
      },
      project_name: project.project_name || '프로젝트',
      studio: deepClone(project.studio || {})
    };
    return JSON.stringify(out, null, 2);
  }

  function deserializeSettingsJson(jsonData) {
    const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    const base = createDefaultProject(data.project_name || '불러온 프로젝트');

    // 구형 xr_audio_scenario.json 호환 지원
    if (Array.isArray(data.tracks) && !data.format) {
      base.video.fps = Number(data.frameRate) || 30;
      base.studio.master_gain = Number(data.masterVolume ?? 1.0);
      base.studio.output_mode = data.outputMode || 'downmix';
      base.sources = data.tracks.map((tr, idx) => ({
        id: `src_${idx + 1}`,
        file: tr.fileName,
        type: tr.type || 'FX',
        delivery: tr.delivery === 'channel' ? 'Channel' : 'Object',
        link: tr.delivery === 'channel' ? { channel_rule: tr.channelRoute || 'auto' } : { csv: tr.pathName || 'custom.csv' },
        start_frame: (Number(tr.startFrame) || 0) + 1,
        end_frame: tr.endFrame !== undefined ? Number(tr.endFrame) + 1 : null,
        questions: { diegetic: tr.type !== 'MX', needs_position: tr.delivery !== 'channel', distance_changes: true },
        distance_cues: true,
        near_rule: true,
        note: '',
        gain_db: 0,
        muted: false,
        solo: false,
        _customPath: tr.pathData || null
      }));
      return base;
    }

    if (data.video) Object.assign(base.video, data.video);
    if (data.oral_values) {
      Object.assign(base.oral_values, data.oral_values);
      base.oral_values.known_sizes_m = Object.assign({}, data.oral_values.known_sizes_m || {});
    }
    if (data.listener) Object.assign(base.listener, data.listener);
    if (data.camera) {
      base.camera.me_target = data.camera.me_target ?? null;
      if (data.camera.horizon) Object.assign(base.camera.horizon, data.camera.horizon);
      if (Array.isArray(data.camera.view_segments) && data.camera.view_segments.length) {
        base.camera.view_segments = deepClone(data.camera.view_segments);
      }
      if (data.camera.height) Object.assign(base.camera.height, data.camera.height);
      if (Array.isArray(data.camera.yaw_keyframes)) base.camera.yaw_keyframes = deepClone(data.camera.yaw_keyframes);
      if (Array.isArray(data.camera.pos_keyframes)) base.camera.pos_keyframes = deepClone(data.camera.pos_keyframes);
    }
    if (Array.isArray(data.targets)) {
      base.targets = data.targets.map(t => {
        const ex = t.studio_extra || {};
        return {
          id: t.id,
          kind: t.kind || 'air',
          ref_point: t.ref_point || 'bbox_center',
          track_tool: t.track_tool || 'sam2',
          distance_method: t.distance_method || 'known_size',
          size_key: t.size_key || null,
          size_axis: t.size_axis || 'max',
          sound_height_m: t.sound_height_m ?? null,
          path_csv: t.path_csv || `${t.id}_path.csv`,
          exclude_edges: Boolean(ex.exclude_edges),
          smooth_window: Number(ex.smooth_window) || 0,
          bridge_gaps: ex.bridge_gaps !== false,
          extend_start: ex.extend_start || 'none',
          extend_end: ex.extend_end || 'none',
          sam_stride: ex.sam_stride || 1,
          prompts: ex.prompts || [],
          manual_keyframes: ex.manual_keyframes || [],
          waypoints: ex.waypoints || [],
          ignored_uncertain: ex.ignored_uncertain || [],
          raw_frames: ex.raw_frames || {}
        };
      });
    }
    if (Array.isArray(data.fixed_sources)) base.fixed_sources = deepClone(data.fixed_sources);
    if (Array.isArray(data.sources)) {
      base.sources = data.sources.map(s => Object.assign({
        gain_db: 0,
        muted: false,
        solo: false,
        questions: { diegetic: true, needs_position: true, distance_changes: true },
        distance_cues: true,
        near_rule: true,
        note: ''
      }, deepClone(s)));
    }
    if (data.outputs) Object.assign(base.outputs, data.outputs);
    if (data.studio) Object.assign(base.studio, data.studio);
    return base;
  }

  /**
   * 대상 동선 CSV 생성 (xr_sound_design.py 및 3회차 동선 CSV 규격 호환)
   */
  function serializeTargetPathCsv(targetId, sceneGraph) {
    const tr = sceneGraph.targetTracks[targetId];
    if (!tr) throw new Error(`대상 '${targetId}' 동선이 없습니다.`);
    const rows = ['frame,time_s,source,azimuth_deg,elevation_deg,distance_m,visible,estimated,confidence,scene_x,scene_y,scene_z,x_px,y_px'];
    let lastValid = tr.frames.find(fr => fr && fr.active) || { azimuth_deg: 0, elevation_deg: 0, distance_m: 2.0, scene_xyz: [0, 2, 0] };
    for (let f = 1; f <= sceneGraph.totalFrames; f++) {
      const fr = tr.frames[f];
      if (fr.active) lastValid = fr;
      const xyz = (fr.active ? fr.scene_xyz : lastValid.scene_xyz) || [0, 2, 0];
      rows.push([
        f,
        fr.time_s.toFixed(4),
        targetId,
        (fr.active ? fr.azimuth_deg : lastValid.azimuth_deg).toFixed(2),
        (fr.active ? fr.elevation_deg : lastValid.elevation_deg).toFixed(2),
        (fr.active ? fr.distance_m : lastValid.distance_m).toFixed(3),
        fr.active ? 1 : 0,
        fr.estimated ? 1 : 0,
        (fr.confidence || 0).toFixed(4),
        xyz[0].toFixed(3),
        xyz[1].toFixed(3),
        xyz[2].toFixed(3),
        fr.x_px !== null && fr.x_px !== undefined ? fr.x_px.toFixed(1) : '',
        fr.y_px !== null && fr.y_px !== undefined ? fr.y_px.toFixed(1) : ''
      ].join(','));
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  /**
   * 프레임별 4채널 게인 로그 CSV 생성 (gain_log.csv)
   */
  function serializeGainLogCsv(project, sceneGraph, rotationOffsetDeg) {
    const rows = ['frame,time_s,source_id,delivery,active,azimuth_deg,elevation_deg,distance_m,gain_FL,gain_FR,gain_RL,gain_RR'];
    const anySolo = project.sources.some(s => s.solo);
    for (let f = 1; f <= sceneGraph.totalFrames; f++) {
      const timeS = ((f - 1) / sceneGraph.fps).toFixed(4);
      for (const s of project.sources) {
        const startF = s.start_frame || 1;
        const endF = s.end_frame || sceneGraph.totalFrames;
        const audible = !s.muted && (!anySolo || s.solo) && f >= startF && f <= endF;
        const trackGain = audible ? Math.pow(10, (Number(s.gain_db) || 0) / 20.0) : 0;

        if (!audible) {
          rows.push(`${f},${timeS},${s.id},${s.delivery},0,0,0,0,0.0000,0.0000,0.0000,0.0000`);
          continue;
        }

        if (s.delivery === 'Object') {
          let fr = null;
          if (s.link && s.link.target && sceneGraph.targetTracks[s.link.target]) {
            fr = sceneGraph.targetTracks[s.link.target].frames[f];
          } else if (s.link && s.link.fixed && sceneGraph.fixedTracks[s.link.fixed]) {
            fr = sceneGraph.fixedTracks[s.link.fixed].frames[f];
          }
          if (!fr || !fr.active) {
            rows.push(`${f},${timeS},${s.id},Object,0,0,0,0,0.0000,0.0000,0.0000,0.0000`);
          } else {
            const g = computeObjectSpeakerGains({
              azimuthDeg: fr.azimuth_deg,
              elevationDeg: fr.elevation_deg,
              distanceM: fr.distance_m,
              rotationOffsetDeg: rotationOffsetDeg || 0,
              elevationScale: project.studio.elevation_spread ?? 1.0,
              frontBackBiasDb: project.studio.front_back_bias_db ?? 0.0,
              applyDistanceCues: s.distance_cues !== false,
              applyNearRule: s.near_rule !== false,
              nearThresholdM: project.oral_values.near_threshold_m ?? 1.5,
              attenRefM: project.oral_values.atten_ref_m ?? 2.0,
              attenK: project.oral_values.atten_k ?? 1.0,
              trackGainLinear: trackGain
            });
            rows.push(`${f},${timeS},${s.id},Object,1,${g.az.toFixed(2)},${g.el.toFixed(2)},${g.dist.toFixed(3)},${g.gains.map(v => v.toFixed(4)).join(',')}`);
          }
        } else if (s.delivery === 'Scene') {
          const yaw = sceneGraph.listenerYaw[f] + (rotationOffsetDeg || 0);
          const m = computeFoaDecodeMatrix(yaw);
          const wGains = m.map(r => (r[0] * trackGain).toFixed(4));
          rows.push(`${f},${timeS},${s.id},Scene,1,${yaw.toFixed(2)},0,0,${wGains.join(',')}`);
        } else {
          const rule = (s.link && s.link.channel_rule) || 'auto';
          const mat = computeChannelRuleGains(rule, 1)[0].map(v => (v * trackGain).toFixed(4));
          rows.push(`${f},${timeS},${s.id},Channel,1,0,0,0,${mat.join(',')}`);
        }
      }
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  /**
   * 외부 동선 CSV 파싱 (1기반·0기반 모두 호환)
   */
  function parsePathCsv(text, defaultFps) {
    const fps = defaultFps || 30;
    const lines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('CSV에 데이터 행이 없습니다.');
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
    const col = names => names.map(n => headers.indexOf(n)).find(i => i >= 0);
    const fIdx = col(['frame', 'frame_idx']);
    const tIdx = col(['time_s', 'time']);
    const azIdx = col(['azimuth_deg', 'azimuth', 'az']);
    const elIdx = col(['elevation_deg', 'elevation', 'el']);
    const dIdx = col(['distance_m', 'distance', 'dist']);
    const vIdx = col(['visible']);
    if (azIdx === undefined) throw new Error('CSV에 azimuth_deg 열이 없습니다.');

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const parts = lines[i].split(',').map(s => s.trim());
      const rawF = fIdx !== undefined ? Number(parts[fIdx]) : i - 1;
      const time = tIdx !== undefined && parts[tIdx] !== '' ? Number(parts[tIdx]) : rawF / fps;
      rows.push({
        rawFrame: rawF,
        time,
        azimuth: Number(parts[azIdx]) || 0,
        elevation: elIdx !== undefined ? (Number(parts[elIdx]) || 0) : 0,
        distance: dIdx !== undefined && parts[dIdx] !== '' ? (Number(parts[dIdx]) || 2.0) : 2.0,
        visible: vIdx === undefined || parts[vIdx] === '' || Number(parts[vIdx]) === 1 ? 1 : 0
      });
    }
    const zeroBased = rows.length > 0 && rows[0].rawFrame === 0;
    return rows.map(r => ({
      frame: zeroBased ? r.rawFrame + 1 : Math.max(1, Math.round(r.rawFrame)),
      time_s: r.time,
      azimuth_deg: r.azimuth,
      elevation_deg: r.elevation,
      distance_m: r.distance,
      visible: r.visible
    }));
  }

  /**
   * 4채널 AudioBuffer 또는 채널 배열 4개를 16-bit PCM WAV ArrayBuffer로 인코딩
   */
  function encodeQuadWavArrayBuffer(channelsData, sampleRate) {
    const numCh = 4;
    const numSamples = channelsData[0].length;
    const blockAlign = numCh * 2;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let c = 0; c < 4; c++) {
        const v = clamp(channelsData[c][i], -1, 1);
        view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        offset += 2;
      }
    }
    return buffer;
  }

  // ===========================================================================
  // 6. 되돌리기 · 다시 하기 히스토리 스택 (Undo / Redo)
  // ===========================================================================
  class HistoryStack {
    constructor(limit) {
      this.limit = limit || 60;
      this.past = [];
      this.future = [];
    }
    push(snapshotJson) {
      if (this.past.length && this.past[this.past.length - 1] === snapshotJson) return;
      this.past.push(snapshotJson);
      if (this.past.length > this.limit) this.past.shift();
      this.future.length = 0;
    }
    undo(currentJson) {
      if (!this.past.length) return null;
      const prev = this.past.pop();
      this.future.push(currentJson);
      return prev;
    }
    redo(currentJson) {
      if (!this.future.length) return null;
      const next = this.future.pop();
      this.past.push(currentJson);
      return next;
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
    clear() { this.past.length = 0; this.future.length = 0; }
  }

  return {
    SPEAKER_AZIMUTHS,
    SPEAKER_IDS,
    SPEED_OF_SOUND,
    clamp,
    wrapDeg,
    lerpAngleDeg,
    smoothstep,
    deepClone,
    createDefaultProject,
    computeIntrinsics,
    pixelToCameraAngles,
    lineIntersection,
    computeHorizonAtFrame,
    detectHorizonFromRgba,
    computeCameraYawSeries,
    getViewAtFrame,
    autoDetectViewSegments,
    extractTarget2DObservations,
    computeSceneGraph,
    projectVideoGroundClick,
    computePairwiseVbap2D,
    computeObjectSpeakerGains,
    computeFoaDecodeMatrix,
    computeChannelRuleGains,
    recommendDeliveryFromQuestions,
    runPreflightCheck,
    serializeSettingsJson,
    deserializeSettingsJson,
    serializeTargetPathCsv,
    serializeGainLogCsv,
    parsePathCsv,
    encodeQuadWavArrayBuffer,
    HistoryStack
  };
});
