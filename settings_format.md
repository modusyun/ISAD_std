# 3회차 설정 JSON 형식 (isad-session3-settings, version 1)

- 영상 하나에 파일 하나: 구조 헬기 영상은 `settings_rescue.json`, 회전 연습 클립은 `settings_turn.json`
- 인코딩 UTF-8. 모르는 값이나 쓰지 않는 값은 `null`
- 단위: 거리 m, 각도 °(방위각·yaw는 오른쪽 +, pitch는 위 +), 프레임은 1부터
- 빈 틀: `settings_template.json`. 이 틀의 키 이름과 구조를 바꾸지 않는다 (키를 더하는 것은 괜찮음)

## 최상위

| 키 | 내용 |
| --- | --- |
| format, version | 고정값 `"isad-session3-settings"`, `1` |
| video | 영상 정보 |
| oral_values | 현장에서 불러 준 값 |
| listener | 청취 기준 |
| camera | 2단계 결과 (지평선, 시점, 카메라 높이, 수평 회전) |
| targets | 추적한 대상 (1·4단계) |
| fixed_sources | 장면에 고정한 음원 위치 (5단계) |
| sources | 음원 목록과 분류 (6·7단계) |
| outputs | 내보낸 파일 이름 |

## video

| 키 | 내용 | 예 |
| --- | --- | --- |
| file | 영상 파일 이름 | `"rescue.mp4"` |
| width_px, height_px | 해상도 | `1280`, `720` |
| fps, frames | 프레임 수 | `30`, `900` |
| hfov_deg | 가로 화각 | `60` |

## oral_values

| 키 | 내용 |
| --- | --- |
| person_height_m | 사람 키 |
| eye_height_m | 1인칭 카메라 높이 |
| near_threshold_m | 가까운 대상 기준 거리 (안이면 네 스피커에 고르게) |
| atten_ref_m, atten_k | 거리 감쇠 기준 거리와 지수 (감쇠 dB = −20·k·log10(거리/기준 거리), 기준 거리 이하는 0) |
| confidence_threshold | 신뢰도 기준값 (이보다 낮으면 화면 밖) |
| known_sizes_m | 크기를 아는 대상의 크기. 이름을 붙여 여러 개 (예: `{"heli_length": 12.0, "heli_rotor": 10.0}`) |

## listener

| 키 | 내용 |
| --- | --- |
| reference | `"camera"` 또는 `"me"`. 제출은 `"camera"` |
| me_ear_height_m, me_facing_deg | '나' 기준일 때 귀 높이와 정면 방향 |

## camera

| 키 | 내용 |
| --- | --- |
| me_target | '나'로 지정한 대상의 id (targets 중 하나) |
| horizon.method | `"auto"`, `"click"`, `"pitch_input"`, `"parallel_lines"`, `"known_person"` 중 주로 쓴 방법 |
| horizon.pitch_input_deg | pitch를 직접 넣었을 때 값 |
| horizon.corrections | 손으로 고친 지평선. `[{"frame": 600, "p1": [x, y], "p2": [x, y]}]` (px) |
| view_segments | 시점 구간. `[{"view": "first_person", "start_frame": 1, "end_frame": 567}]`. view는 `"first_person"`, `"transition"`, `"third_person"` |
| height.first_person_m | 1인칭 카메라 높이 |
| height.third_person_method | `"from_person"`(사람 키로 계산) 또는 `"input"`(직접 입력) |
| height.third_person_input_m | 직접 입력했을 때 값 |
| height.height_person_target | 키로 계산할 때 쓴 대상의 id |
| yaw_keyframes | 수평 회전. `[{"start_frame": 61, "end_frame": 121, "to_deg": 90.0, "interp": "ease"}]`. interp는 `"linear"` 또는 `"ease"`. 회전이 없으면 `[]` |

## targets (대상마다 하나)

| 키 | 내용 |
| --- | --- |
| id | 대상 이름 (영문, 동선 CSV의 source와 같게) |
| kind | `"air"`(공중) 또는 `"ground"`(땅 위) |
| ref_point | `"bbox_center"` 또는 `"bbox_bottom_center"` |
| track_tool | `"sam2"`, `"keyframe"`, `"other"` |
| distance_method | `"ground_contact"`(지면 접점법) 또는 `"known_size"`(기준 크기법) |
| size_key, size_axis | 기준 크기법일 때 쓴 크기 이름(known_sizes_m의 키)과 화면 쪽(`"width"`, `"height"`, `"max"`) |
| sound_height_m | 지면 접점법 대상의 소리 높이 |
| path_csv | 이 대상의 동선 CSV 파일 이름 |

## fixed_sources (고정 음원 위치마다 하나)

| 키 | 내용 |
| --- | --- |
| id | 위치 이름 |
| from_target, frame | 클릭한 대상과 프레임 (직접 입력이면 null) |
| scene_xyz_m | 장면 좌표 [x, y, z] |

## sources (등록한 음원마다 하나. 같은 파일을 여러 번 등록하면 여러 개)

| 키 | 내용 |
| --- | --- |
| id | 등록 이름 |
| file | 음원 파일 이름 |
| type | `"DX"`, `"FX"`, `"MX"` |
| delivery | `"Object"`, `"Channel"`, `"Scene"` |
| link | 연결. Object면 `{"target": "heli"}`(동선) 또는 `{"fixed": "me_position"}`(고정 위치), Channel이면 `{"channel_rule": "DX_center"}` 등 2회차 규칙 이름, Scene이면 `{"scene": "foa_ambix"}` |
| start_frame, end_frame | 재생 구간 (end가 null이면 파일 끝까지) |
| questions | 분류 질문 3개. `{"diegetic": true, "needs_position": true, "distance_changes": true}` |
| distance_cues | 거리 단서 적용 여부 |
| near_rule | 가까운 대상 기준 적용 여부 |
| note | 판단 이유 메모 (한 줄) |

## outputs

| 키 | 내용 |
| --- | --- |
| wav_4ch, video_mp4, gain_log_csv | 내보낸 파일 이름 |
| path_csvs | 동선 CSV 파일 이름 목록 |

## 구조 헬기 영상의 음원 파일

- s01_rotor.wav, s02_here.wav, s03_radio.wav, s04_ladder.wav, s05_no.wav, s06_wind_foa_ambix.wav(FOA AmbiX 4채널), s07_music.wav
- sources의 file에는 이 이름을 그대로 쓴다
