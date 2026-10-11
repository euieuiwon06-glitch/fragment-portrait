# FRAGMENT PORTRAIT — SCATTER (8743)

20장의 사각형이 화면에 흩어져 돌아다니다가, 사람이 감지되면 0.5초마다 한 장씩 그 순간의 모습을 찍고
크기 제각각인 카드로 겹쳐 쌓이는 러프한 자리로 날아가 박힌다. 20장이 다 박히면 분절 초상화 완성. 사람 외 배경은 흰색으로 지우고, 화면 바탕은 검정.

격자에 바로 찍히는 기본형은 `../fragment-portrait-8742`.

## 실행

```
cd fragment-portrait-8743
python -m http.server 8743
```

→ http://localhost:8743

## 조작

화면에 UI는 없고 키보드로만 조작한다.

- **R / Space**: 박힌 조각들이 다시 흩어지고 처음부터
- **S**: 완성 후 PNG 저장
- `?debug=1`: 마스크·감지값 표시 / `?demo=1`: 카메라 없이 확인

## 조절값 (app.js 맨 위 `CFG`)

| 값 | 기본 | 설명 |
|---|---|---|
| cols / rows | 4 / 5 | 격자 |
| interval | 500 | 캡처 간격(ms) |
| cardContent | live | `live` = 떠다니는 카드에 자기 칸의 실시간 영상, `blank` = 빈 흰 카드 |
| wanderSpeed / wanderRotate | 90 / 28 | 떠다니는 속도(px/s) / 기울기(도) |
| wanderScale | 0.9 | 떠다닐 때 카드 크기 |
| flyMs / flyOvershoot | 750 / 1.25 | 날아가는 시간 / 도착 반동 |
| cardArea / cardAspect | [1.3, 1.6] / [0.4, 2.2] | 카드 넓이 (클수록 많이 겹침) / 가로:세로 비율 범위 |
| rowShift / posJitter | 0.35 / [0.15, 0.18] | 줄마다 좌우로 밀림 / 카드마다 위치 흔들림 |
| srcShift / zoom | [0.12, 0.08] / [0.9, 1.2] | 카드 속 사진 어긋남 / 확대율 |
| portraitScale | 1 | 안전영역을 꽉 채운 크기 대비 완성본 크기 |
| safeTop / safeBottom / safeSide | 56 / 56 / 24 | 화면 위·아래·좌우 안전영역(px) |
| background | #000 | 화면·저장 이미지 바탕색 (카드는 흰색) |
| grayscale | true | 피사체 흑백 (false = 컬러) |
