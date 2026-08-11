#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
지능형 영상 요약 플랫폼 — Mock veri üretici
==========================================

Bu betik, frontend mockup'ı için gerçekçi bir veri seti üretir:

  * 4 grup / 11 kamera — her `video_status` değeri temsil edilir
  * Senaryolu track verisi (bbox yörüngeleri) — sentetik videoyla birebir uyumlu
  * PAR öznitelikleri (cinsiyet, giysi rengi, taşınan eşya…)
  * 이벤트 후보 구간 선정 skorları (event_candidate_score)
  * VLM tarzı Korece olay açıklamaları
  * Re-ID embedding'leri:
      - senaryo nesneleri için kimlik yapısı kurgulanmış sentetik vektörler
      - `fur/human/db_datas` içinden 165 adet GERÇEK SOLIDER (1024-d) vektörü
        ve bunlara ait gerçek kırpma görüntüleri

Çıktı:  mock/data/*.json, mock/data/embeddings.f32, mock/assets/crops/*.jpg
Ayrıca: mock/data/tracks_render.json  (gen_video.py bunu kullanır)

Kullanım:  python tools/gen_mock.py
"""

import json
import math
import os
import random
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MOCK = ROOT / "mock"
DATA = MOCK / "data"
ASSETS = MOCK / "assets"
CROPS = ASSETS / "crops"

HUMAN = Path(r"C:\Users\admin\fur\human\db_datas")

random.seed(20250520)
np.random.seed(20250520)

# ---------------------------------------------------------------------------
# Sabitler — bunlar aynı zamanda API sözleşmesinin enum tanımlarıdır
# ---------------------------------------------------------------------------

# DB şemasındaki enum tanımları (video_analytics_schema_v2) ile birebir.
# Yazım farkı bile entegrasyonda hata demek — örn. "canceled" tek L.
VIDEO_STATUS = ["registered", "uploading", "ready", "analyzing",
                "completed", "failed", "deleted"]
SOURCE_TYPE = ["file", "rtsp", "uploaded", "archive"]
ANALYSIS_RUN_STATUS = ["queued", "running", "completed", "failed", "canceled"]
EVENT_STATUS = ["candidate", "confirmed", "dismissed"]
IDENTITY_MATCH_STATUS = ["candidate", "confirmed", "rejected"]

# public_id üretimi — deterministik olsun ki her gen_mock aynı UUID'yi versin
_NS = uuid.UUID("6f9b1c2a-4d3e-5a7b-8c9d-0e1f2a3b4c5d")


def pid(*parts):
    return str(uuid.uuid5(_NS, "|".join(str(p) for p in parts)))

# PAR sözlüğü — UI filtre paneli BUNU okur, sabit kodlamaz
ATTRIBUTES = {
    "person": [
        {"key": "gender", "label_ko": "성별", "label_tr": "Cinsiyet", "type": "single",
         "values": [
             {"v": "male", "ko": "남성", "tr": "Erkek"},
             {"v": "female", "ko": "여성", "tr": "Kadın"}]},
        {"key": "age", "label_ko": "연령대", "label_tr": "Yaş grubu", "type": "single",
         "values": [
             {"v": "child", "ko": "어린이", "tr": "Çocuk"},
             {"v": "adult", "ko": "성인", "tr": "Yetişkin"},
             {"v": "senior", "ko": "노인", "tr": "Yaşlı"}]},
        {"key": "upper_color", "label_ko": "상의 색상", "label_tr": "Üst giysi rengi",
         "type": "color", "values": [
             {"v": "red", "ko": "빨강", "tr": "Kırmızı", "hex": "#ef4444"},
             {"v": "orange", "ko": "주황", "tr": "Turuncu", "hex": "#f97316"},
             {"v": "yellow", "ko": "노랑", "tr": "Sarı", "hex": "#eab308"},
             {"v": "green", "ko": "초록", "tr": "Yeşil", "hex": "#22c55e"},
             {"v": "blue", "ko": "파랑", "tr": "Mavi", "hex": "#3b82f6"},
             {"v": "purple", "ko": "보라", "tr": "Mor", "hex": "#a855f7"},
             {"v": "white", "ko": "흰색", "tr": "Beyaz", "hex": "#f8fafc"},
             {"v": "gray", "ko": "회색", "tr": "Gri", "hex": "#94a3b8"},
             {"v": "black", "ko": "검정", "tr": "Siyah", "hex": "#1e293b"}]},
        {"key": "upper_type", "label_ko": "상의 종류", "label_tr": "Üst giysi tipi",
         "type": "single", "values": [
             {"v": "short_sleeve", "ko": "반팔", "tr": "Kısa kol"},
             {"v": "long_sleeve", "ko": "긴팔", "tr": "Uzun kol"},
             {"v": "jacket", "ko": "재킷", "tr": "Ceket"},
             {"v": "coat", "ko": "코트", "tr": "Palto"}]},
        {"key": "lower_color", "label_ko": "하의 색상", "label_tr": "Alt giysi rengi",
         "type": "color", "values": [
             {"v": "blue", "ko": "파랑", "tr": "Mavi", "hex": "#3b82f6"},
             {"v": "black", "ko": "검정", "tr": "Siyah", "hex": "#1e293b"},
             {"v": "gray", "ko": "회색", "tr": "Gri", "hex": "#94a3b8"},
             {"v": "beige", "ko": "베이지", "tr": "Bej", "hex": "#d6c7a1"},
             {"v": "white", "ko": "흰색", "tr": "Beyaz", "hex": "#f8fafc"}]},
        {"key": "carry", "label_ko": "소지품", "label_tr": "Taşınan eşya",
         "type": "multi", "values": [
             {"v": "backpack", "ko": "백팩", "tr": "Sırt çantası"},
             {"v": "handbag", "ko": "핸드백", "tr": "El çantası"},
             {"v": "umbrella", "ko": "우산", "tr": "Şemsiye"},
             {"v": "box", "ko": "상자", "tr": "Kutu"}]},
        {"key": "hat", "label_ko": "모자", "label_tr": "Şapka", "type": "bool",
         "values": [{"v": "yes", "ko": "착용", "tr": "Var"},
                    {"v": "no", "ko": "미착용", "tr": "Yok"}]},
    ],
    "vehicle": [
        {"key": "vehicle_type", "label_ko": "차량 종류", "label_tr": "Araç tipi",
         "type": "single", "values": [
             {"v": "sedan", "ko": "승용차", "tr": "Sedan"},
             {"v": "suv", "ko": "SUV", "tr": "SUV"},
             {"v": "truck", "ko": "트럭", "tr": "Kamyon"},
             {"v": "bus", "ko": "버스", "tr": "Otobüs"},
             {"v": "motorcycle", "ko": "오토바이", "tr": "Motosiklet"}]},
        {"key": "vehicle_color", "label_ko": "차량 색상", "label_tr": "Araç rengi",
         "type": "color", "values": [
             {"v": "white", "ko": "흰색", "tr": "Beyaz", "hex": "#f8fafc"},
             {"v": "black", "ko": "검정", "tr": "Siyah", "hex": "#1e293b"},
             {"v": "gray", "ko": "회색", "tr": "Gri", "hex": "#94a3b8"},
             {"v": "silver", "ko": "은색", "tr": "Gümüş", "hex": "#cbd5e1"},
             {"v": "blue", "ko": "파랑", "tr": "Mavi", "hex": "#3b82f6"},
             {"v": "red", "ko": "빨강", "tr": "Kırmızı", "hex": "#ef4444"}]},
    ],
}

# ---------------------------------------------------------------------------
# Aday구간 선정 지표 (Plan 1) — DB: event_candidate_score.metric_code
# ---------------------------------------------------------------------------
# Plan 1'in "후보 구간 판단 조건" tablosu ve akış şemasındaki analiz kolları.
# Her metrik bir zaman penceresi için 0~1 arası bir "ihlal skoru" üretir;
# ağırlıklı toplam eşiği aşarsa o pencere VLM'e gönderilir.
METRICS = {
    "pixel_change":  {"ko": "픽셀 변화량",       "tr": "Piksel değişimi",
                      "w": 0.10, "thr": 0.55,
                      "desc": "프레임 차이 및 Optical Flow"},
    "motion_change": {"ko": "객체 움직임 변화",  "tr": "Hareket değişimi",
                      "w": 0.18, "thr": 0.55,
                      "desc": "BBox 속도·방향·가속도"},
    "object_count":  {"ko": "객체 수 변화",      "tr": "Nesne sayısı değişimi",
                      "w": 0.12, "thr": 0.60,
                      "desc": "클래스별 BBox 개수 변화"},
    "track_churn":   {"ko": "등장·소멸",         "tr": "Giriş/çıkış",
                      "w": 0.15, "thr": 0.55,
                      "desc": "신규 Track 등장 및 소멸 비율"},
    "interaction":   {"ko": "객체 간 상호작용",  "tr": "Nesneler arası etkileşim",
                      "w": 0.20, "thr": 0.55,
                      "desc": "BBox 중심 간 거리와 접근 속도"},
    "dwell":         {"ko": "장시간 체류",       "tr": "Uzun süreli bekleme",
                      "w": 0.13, "thr": 0.60,
                      "desc": "동일 객체의 위치 고정 시간"},
    "posture":       {"ko": "상태 변화",         "tr": "Duruş değişimi",
                      "w": 0.12, "thr": 0.55,
                      "desc": "BBox 비율·자세 변화 (쓰러짐 등)"},
}

WINDOW_SEC_CAND = 2.0        # aday penceresi uzunluğu
CANDIDATE_THRESHOLD = 0.42   # ağırlıklı toplam bu değeri aşarsa aday

VIDEO_FPS = 10               # sentetik CCTV — gerçekçi kare hızı
VIDEO_W, VIDEO_H = 960, 540
WINDOW_START = datetime(2025, 5, 20, 8, 30, 0)
WINDOW_SEC = 180


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------

def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S+09:00")


def lerp(a, b, u):
    return a + (b - a) * u


def ease(u):
    """Yumuşak hızlanma/yavaşlama — yürüyüş doğal görünsün."""
    return u * u * (3 - 2 * u)


class Track:
    """Bir nesnenin zaman içindeki yörüngesi.

    waypoints: [(t_sec, cx, cy, h_norm)]  — cx,cy merkez (0-1), h yükseklik (0-1)
    En/boy oranı sınıfa göre türetilir.
    """

    def __init__(self, tid, cls, waypoints, attrs, aspect=None, label=None):
        self.tid = tid
        self.cls = cls
        self.waypoints = sorted(waypoints, key=lambda w: w[0])
        self.attrs = attrs
        self.aspect = aspect if aspect else (0.42 if cls == "person" else 2.2)
        self.label = label

    @property
    def t0(self):
        return self.waypoints[0][0]

    @property
    def t1(self):
        return self.waypoints[-1][0]

    def at(self, t):
        """t anındaki (x1,y1,x2,y2) normalize kutu; aralık dışıysa None."""
        if t < self.t0 - 1e-6 or t > self.t1 + 1e-6:
            return None
        wp = self.waypoints
        for i in range(len(wp) - 1):
            ta, xa, ya, ha = wp[i]
            tb, xb, yb, hb = wp[i + 1]
            if ta <= t <= tb:
                u = 0.0 if tb == ta else (t - ta) / (tb - ta)
                u = ease(u)
                cx, cy, h = lerp(xa, xb, u), lerp(ya, yb, u), lerp(ha, hb, u)
                break
        else:
            _, cx, cy, h = wp[-1]
        w = h * self.aspect
        # küçük doğal titreşim — gerçek detektör çıktısı gibi
        jx = math.sin(t * 5.1 + self.tid) * 0.0022
        jy = math.cos(t * 4.3 + self.tid * 2) * 0.0018
        jh = 1.0 + math.sin(t * 6.7 + self.tid) * 0.012
        h *= jh
        w *= jh
        return (
            round(max(0.0, cx - w / 2 + jx), 4),
            round(max(0.0, cy - h / 2 + jy), 4),
            round(min(1.0, cx + w / 2 + jx), 4),
            round(min(1.0, cy + h / 2 + jy), 4),
        )

    def conf(self, t):
        base = 0.86 if self.cls == "person" else 0.91
        return round(min(0.99, base + 0.07 * math.sin(t * 3.3 + self.tid)), 3)


# ---------------------------------------------------------------------------
# Senaryolar — her kamera için track listesi + kavram zaman çizelgesi
# ---------------------------------------------------------------------------

def person_attrs(gender, age, up_c, up_t, lo_c, carry, hat="no"):
    return {"gender": gender, "age": age, "upper_color": up_c,
            "upper_type": up_t, "lower_color": lo_c,
            "carry": carry, "hat": hat}


def vehicle_attrs(vt, vc):
    return {"vehicle_type": vt, "vehicle_color": vc}


def scenario_cam01():
    """정문 (ana kapı) — hikâyenin başladığı yer.

    P1 (beyaz gömlek + sırt çantası, hedef kişi) kapıdan giriyor, duruyor,
    telefonla konuşuyor, etrafa bakıyor, sonra sağa doğru uzaklaşıyor.
    Arka planda: kırmızı montlu kadın (dikkat dağıtıcı), bir bisikletli.
    """
    T = []
    # P1 — hedef kişi. Kapıdan (üst orta, uzak) kameraya doğru yürür → büyür.
    T.append(Track(1, "person", [
        (2.0, 0.50, 0.30, 0.10),
        (14.0, 0.49, 0.42, 0.20),
        (26.0, 0.47, 0.56, 0.32),
        (38.0, 0.46, 0.62, 0.38),   # durur
        (72.0, 0.455, 0.63, 0.385),  # telefonla konuşur (yerinde)
        (86.0, 0.52, 0.66, 0.41),
        (104.0, 0.72, 0.70, 0.44),
        (118.0, 0.93, 0.74, 0.47),
    ], person_attrs("male", "adult", "white", "long_sleeve", "black",
                    ["backpack"]), label="P1 · 흰색 셔츠 남성"))

    # P2 — kırmızı montlu kadın, soldan sağa geçer (dikkat dağıtıcı)
    T.append(Track(2, "person", [
        (20.0, -0.05, 0.48, 0.24),
        (48.0, 0.30, 0.50, 0.26),
        (76.0, 0.70, 0.52, 0.27),
        (100.0, 1.05, 0.54, 0.28),
    ], person_attrs("female", "adult", "red", "jacket", "blue", ["handbag"]),
        label="P2 · 빨간 재킷 여성"))

    # P3 — siyah paltolu adam, sağdan girer, kapıya doğru gider
    T.append(Track(3, "person", [
        (96.0, 1.04, 0.60, 0.30),
        (120.0, 0.70, 0.52, 0.25),
        (144.0, 0.55, 0.40, 0.17),
        (166.0, 0.51, 0.31, 0.11),
    ], person_attrs("male", "adult", "black", "coat", "gray", []),
        label="P3 · 검정 코트 남성"))

    # V1 — gri SUV, arka planda yoldan geçer
    T.append(Track(4, "vehicle", [
        (130.0, 1.10, 0.34, 0.13),
        (152.0, 0.40, 0.33, 0.14),
        (168.0, -0.10, 0.33, 0.14),
    ], vehicle_attrs("suv", "gray"), aspect=2.1, label="V1 · 회색 SUV"))

    concepts = [
        (0, 180, {"person": 0.55, "walk": 0.30}),
        (2, 30, {"enter": 0.95, "person": 0.85, "walk": 0.7, "bag": 0.5}),
        (38, 74, {"phone": 0.92, "stand": 0.85, "person": 0.8, "loiter": 0.45}),
        (86, 120, {"walk": 0.8, "exit": 0.55, "person": 0.8}),
        (130, 170, {"vehicle": 0.8}),
    ]
    return T, concepts


def scenario_cam02():
    """주차장 (otopark) — P1 buraya geçiyor ve araca biniyor."""
    T = []
    # V2 — siyah sedan, sağdan girer ve park eder
    T.append(Track(11, "vehicle", [
        (8.0, 1.12, 0.40, 0.14),
        (26.0, 0.72, 0.46, 0.19),
        (44.0, 0.46, 0.55, 0.25),
        (58.0, 0.42, 0.58, 0.27),
        (180.0, 0.42, 0.58, 0.27),
    ], vehicle_attrs("sedan", "black"), aspect=2.3, label="V2 · 검정 세단"))

    # P1 (aynı kişi, farklı kamera → Re-ID hedefi). track_id farklı olmalı!
    T.append(Track(12, "person", [
        (62.0, -0.04, 0.52, 0.26),
        (78.0, 0.18, 0.56, 0.30),
        (94.0, 0.33, 0.60, 0.34),
        (106.0, 0.375, 0.605, 0.35),   # araca yaklaşır
        (112.0, 0.40, 0.60, 0.34),     # kapıyı açar
        (118.0, 0.43, 0.585, 0.30),    # biner — küçülür
        (122.0, 0.44, 0.58, 0.20),
        (124.0, 0.44, 0.58, 0.10),     # kaybolur
    ], person_attrs("male", "adult", "white", "long_sleeve", "black",
                    ["backpack"]), label="P1 · 흰색 셔츠 남성 (동일 인물)"))

    # P4 — park halindeki araçlar arasında yürüyen biri
    T.append(Track(13, "person", [
        (20.0, 0.85, 0.62, 0.28),
        (52.0, 0.80, 0.66, 0.30),
        (80.0, 0.88, 0.70, 0.32),
        (110.0, 1.06, 0.72, 0.33),
    ], person_attrs("female", "adult", "blue", "short_sleeve", "white",
                    ["handbag"]), label="P4 · 파란 상의 여성"))

    # V2 hareket eder (park yerinden çıkar) — 130-160
    T.append(Track(14, "vehicle", [
        (130.0, 0.42, 0.58, 0.27),
        (148.0, 0.70, 0.47, 0.20),
        (164.0, 1.10, 0.41, 0.15),
    ], vehicle_attrs("sedan", "black"), aspect=2.3, label="V2 · 검정 세단 (출차)"))

    concepts = [
        (0, 180, {"vehicle": 0.6, "person": 0.35}),
        (8, 58, {"enter": 0.85, "vehicle": 0.95}),
        (62, 106, {"person": 0.9, "walk": 0.8, "bag": 0.5}),
        (106, 126, {"board_vehicle": 0.96, "person": 0.85, "vehicle": 0.85}),
        (130, 168, {"exit": 0.9, "vehicle": 0.95}),
    ]
    return T, concepts


def scenario_cam03():
    """후문 (arka kapı) — batı: birinin uzun süre orada oyalanması."""
    T = []
    T.append(Track(21, "person", [
        (6.0, 0.22, 0.55, 0.30),
        (26.0, 0.62, 0.56, 0.31),
        (46.0, 0.24, 0.55, 0.30),
        (66.0, 0.64, 0.57, 0.31),
        (88.0, 0.26, 0.56, 0.30),
        (110.0, 0.60, 0.56, 0.31),
        (132.0, 0.30, 0.55, 0.30),
        (156.0, 0.58, 0.57, 0.31),
        (176.0, 0.35, 0.56, 0.30),
    ], person_attrs("male", "adult", "gray", "jacket", "black", ["backpack"],
                    hat="yes"), label="P5 · 배회하는 남성"))

    # Bırakılan çanta (abandon senaryosu) — 120'den sonra sabit
    T.append(Track(22, "person", [
        (100.0, 0.86, 0.60, 0.29),
        (116.0, 0.78, 0.62, 0.30),
        (132.0, 0.94, 0.62, 0.30),
        (146.0, 1.06, 0.62, 0.30),
    ], person_attrs("male", "adult", "green", "short_sleeve", "beige", ["box"]),
        label="P6 · 상자를 든 남성"))

    concepts = [
        (0, 180, {"person": 0.7, "walk": 0.5}),
        (6, 176, {"loiter": 0.88, "person": 0.85, "stand": 0.4}),
        (100, 148, {"abandon": 0.6, "bag": 0.55, "person": 0.7}),
    ]
    return T, concepts


def scenario_cam04():
    """로비 — kalabalık, ve 150. saniyede bir düşme olayı."""
    T = []
    base = [
        (31, 0.10, 0.58, 0.30, 0.90, "female", "yellow", "short_sleeve"),
        (32, 0.28, 0.56, 0.29, 1.10, "male", "blue", "long_sleeve"),
        (33, 0.48, 0.60, 0.31, 0.80, "male", "black", "jacket"),
        (34, 0.66, 0.57, 0.29, 1.00, "female", "white", "short_sleeve"),
        (35, 0.84, 0.59, 0.30, 0.95, "male", "gray", "long_sleeve"),
    ]
    for tid, x0, y0, h, spd, g, uc, ut in base:
        pts = []
        for k in range(0, 10):
            t = k * 20.0
            x = (x0 + math.sin(t * 0.02 * spd + tid) * 0.30) % 1.0
            y = y0 + math.cos(t * 0.015 * spd + tid) * 0.04
            pts.append((t, round(x, 3), round(y, 3), h))
        T.append(Track(tid, "person", pts,
                       person_attrs(g, "adult", uc, ut, "black", []),
                       label=f"P{tid} · 로비 통행"))

    # P7 — 150. saniyede düşer: yükseklik daralır, en/boy oranı tersine döner
    T.append(Track(36, "person", [
        (120.0, 0.55, 0.55, 0.30),
        (144.0, 0.52, 0.62, 0.32),
        (150.0, 0.51, 0.68, 0.26),
        (153.0, 0.50, 0.74, 0.14),   # yere düşer
        (180.0, 0.50, 0.75, 0.13),   # yerde kalır
    ], person_attrs("senior", "senior", "purple", "coat", "gray", []),
        aspect=0.45, label="P7 · 쓰러진 노인"))

    concepts = [
        (0, 180, {"person": 0.9, "crowd": 0.7, "walk": 0.75}),
        (145, 180, {"fall": 0.94, "person": 0.9, "crowd": 0.6}),
    ]
    return T, concepts


SCENARIOS = {
    "CAM01": scenario_cam01,
    "CAM02": scenario_cam02,
    "CAM03": scenario_cam03,
    "CAM04": scenario_cam04,
}

# Sahne arka plan tarifleri — gen_video.py bunları çizer
SCENE_STYLE = {
    "CAM01": {"kind": "gate", "tint": (34, 44, 38)},
    "CAM02": {"kind": "parking", "tint": (38, 40, 48)},
    "CAM03": {"kind": "backgate", "tint": (30, 34, 40)},
    "CAM04": {"kind": "lobby", "tint": (44, 42, 40)},
}

# ---------------------------------------------------------------------------
# Olaylar — VLM'in üreteceği doğal dil açıklamalar
# ---------------------------------------------------------------------------

EVENTS = {
    "CAM01": [
        (3.0, 12.0, "흰색 셔츠를 입은 남성이 백팩을 메고 정문으로 들어오는 모습",
         "White-shirted man with a backpack entering through the main gate",
         "enter", 0.91, [1]),
        (38.0, 72.0, "정문 안쪽에서 통화를 하며 주변을 살피는 모습",
         "Standing inside the gate, talking on the phone and looking around",
         "phone", 0.88, [1]),
        (20.0, 46.0, "빨간 재킷을 입은 여성이 좌측에서 우측으로 통행",
         "Woman in a red jacket walking from left to right",
         "walk", 0.62, [2]),
        (86.0, 118.0, "남성이 우측 방향으로 이동하여 화면에서 벗어남",
         "The man moves to the right and leaves the frame",
         "exit", 0.79, [1]),
        (130.0, 168.0, "회색 SUV가 배경 도로를 통과",
         "A gray SUV passes along the background road",
         "vehicle", 0.55, [4]),
    ],
    "CAM02": [
        (9.0, 30.0, "검은색 차량(세단)이 주차장으로 진입",
         "A black sedan enters the parking lot",
         "enter", 0.86, [11]),
        (44.0, 58.0, "차량이 주차 구획에 정차",
         "The vehicle parks in a marked bay",
         "vehicle", 0.71, [11]),
        (62.0, 104.0, "백팩을 멘 남성이 좌측에서 진입하여 정차 차량으로 접근",
         "A man with a backpack enters from the left and approaches the parked car",
         "walk", 0.83, [12]),
        (106.0, 124.0, "남성이 차량 조수석에 탑승",
         "The man boards the passenger seat of the vehicle",
         "board_vehicle", 0.94, [12, 11]),
        (130.0, 166.0, "차량이 주차장을 빠져나감",
         "The vehicle leaves the parking lot",
         "exit", 0.89, [14]),
    ],
    "CAM03": [
        (6.0, 176.0, "회색 재킷에 모자를 쓴 남성이 후문 주변을 반복적으로 배회",
         "A man in a gray jacket and cap repeatedly loitering near the back gate",
         "loiter", 0.92, [21]),
        (100.0, 146.0, "상자를 든 남성이 후문 인근에 잠시 머무름",
         "A man carrying a box briefly stays near the back gate",
         "abandon", 0.58, [22]),
    ],
    "CAM04": [
        (0.0, 180.0, "로비를 통행하는 다수의 인원이 지속적으로 관측됨",
         "Multiple people continuously moving through the lobby",
         "crowd", 0.66, [31, 32, 33, 34, 35]),
        (148.0, 158.0, "보라색 코트를 입은 노인이 로비 중앙에서 쓰러짐",
         "An elderly person in a purple coat collapses in the middle of the lobby",
         "fall", 0.95, [36]),
        (158.0, 180.0, "쓰러진 인원이 일어나지 못하고 그대로 머무름",
         "The fallen person remains on the ground without getting up",
         "fall", 0.87, [36]),
    ],
}

# vlm_event.event_group_id — birden fazla kameradaki AYNI olayı bağlayan UUID.
# Şemada bu alanın olması, "olaylar bağımsız mı, bir hikâyenin parçası mı"
# sorusunun cevabıdır: hikâyenin parçası. UI bunları tek senaryo olarak gösterir.
EVENT_GROUPS = {
    # P1'in hikâyesi: kapıdan girdi → telefon → otoparka geçti → araca bindi
    "INC-1": ["CAM01-E1", "CAM01-E2", "CAM01-E4", "CAM02-E3", "CAM02-E4"],
    # Aracın hikâyesi: girdi → park etti → çıktı
    "INC-2": ["CAM02-E1", "CAM02-E2", "CAM02-E5"],
    # Arka kapıdaki şüpheli davranış
    "INC-3": ["CAM03-E1", "CAM03-E2"],
    # Lobideki düşme olayı
    "INC-4": ["CAM04-E2", "CAM04-E3"],
}
EVENT_GROUP_TITLE = {
    "INC-1": "백팩 남성의 정문 진입 후 주차장 차량 탑승",
    "INC-2": "검정 세단의 주차장 진입 및 출차",
    "INC-3": "후문 주변 반복 배회",
    "INC-4": "로비 내 인원 쓰러짐",
}
EVENT_OF_GROUP = {eid: gid for gid, ids in EVENT_GROUPS.items() for eid in ids}

# event_type.code — şemadaki event_type tablosunun içeriği
EVENT_TYPE_META = {
    "enter": {"ko": "진입", "tr": "Giriş", "color": "#38bdf8", "sev": "info"},
    "exit": {"ko": "이탈", "tr": "Çıkış", "color": "#818cf8", "sev": "info"},
    "walk": {"ko": "통행", "tr": "Geçiş", "color": "#64748b", "sev": "info"},
    "phone": {"ko": "통화", "tr": "Telefon", "color": "#2dd4bf", "sev": "info"},
    "vehicle": {"ko": "차량", "tr": "Araç", "color": "#a78bfa", "sev": "info"},
    "board_vehicle": {"ko": "탑승", "tr": "Araca biniş", "color": "#fbbf24", "sev": "warn"},
    "loiter": {"ko": "배회", "tr": "Başıboş dolaşma", "color": "#fb923c", "sev": "warn"},
    "abandon": {"ko": "방치", "tr": "Terk edilmiş eşya", "color": "#f59e0b", "sev": "warn"},
    "crowd": {"ko": "밀집", "tr": "Kalabalık", "color": "#94a3b8", "sev": "info"},
    "fall": {"ko": "쓰러짐", "tr": "Düşme", "color": "#ef4444", "sev": "critical"},
    "fight": {"ko": "싸움", "tr": "Kavga", "color": "#dc2626", "sev": "critical"},
    "fire_smoke": {"ko": "화재/연기", "tr": "Yangın/duman", "color": "#f97316", "sev": "critical"},
}


# ---------------------------------------------------------------------------
# Katalog: gruplar, kameralar, videolar
# ---------------------------------------------------------------------------

def build_catalog():
    groups = []

    # --- Area1: oynatılabilir sentetik videolu ana senaryo ------------------
    a1 = {"id": "G1", "name": "Area1", "name_ko": "본관 주차장",
          "desc": "메인 시나리오 · 재생 가능한 프록시 영상 포함", "cameras": []}
    cams1 = [
        ("CAM01", "Camera1", "정문", 20003, 0),
        ("CAM02", "Camera2", "주차장", 20004, 0),
        ("CAM03", "Camera3", "후문", 20005, 0),
        ("CAM04", "Camera4", "로비", 20006, 0),
    ]
    for cid, cname, place, node, ch in cams1:
        a1["cameras"].append({
            "id": cid, "name": cname, "place_ko": place,
            "node_id": node, "ch": ch,
            "status": "completed", "source_type": "archive",
            "has_proxy": True,
            "start_time": iso(WINDOW_START),
            "end_time": iso(WINDOW_START + timedelta(seconds=WINDOW_SEC)),
            "duration": WINDOW_SEC, "fps": VIDEO_FPS,
            "width": VIDEO_W, "height": VIDEO_H,
            "codec": "h264", "src_codec": "hevc",
            "bitrate_kbps": 1800, "file_size_mb": round(1800 * WINDOW_SEC / 8 / 1024, 1),
            "gop_sec": 1.0, "faststart": True,
        })
    groups.append(a1)

    # --- Area2: 24 saatlik, analiz edilmiş, proxy video YOK (ölçek demosu) --
    a2 = {"id": "G2", "name": "Area2", "name_ko": "물류창고",
          "desc": "24시간 분석 완료 · 프록시 영상 없음 (대규모 타임라인 시연)",
          "cameras": []}
    for i, (cid, cname, place, node) in enumerate([
            ("CAM05", "Camera5", "창고 A동", 21010),
            ("CAM06", "Camera6", "창고 B동", 21011),
            ("CAM07", "Camera7", "하역장", 21012)]):
        a2["cameras"].append({
            "id": cid, "name": cname, "place_ko": place, "node_id": node, "ch": 0,
            "status": "completed", "source_type": "file", "has_proxy": False,
            "start_time": iso(datetime(2025, 5, 20, 0, 0, 0)),
            "end_time": iso(datetime(2025, 5, 20, 23, 59, 59)),
            "duration": 86399, "fps": 15, "width": 1920, "height": 1080,
            "codec": "h264", "src_codec": "hevc", "bitrate_kbps": 4096,
            "file_size_mb": 42200, "gop_sec": 2.0, "faststart": True,
        })
    groups.append(a2)

    # --- Area3: analiz edilmemiş / hatalı ----------------------------------
    a3 = {"id": "G3", "name": "Area3", "name_ko": "근린공원", "desc": "미분석 · 오류 사례",
          "cameras": [
              {"id": "CAM08", "name": "Camera8", "place_ko": "공원 입구",
               "node_id": 22001, "ch": 0, "status": "ready",
               "source_type": "uploaded", "has_proxy": False,
               "start_time": iso(datetime(2025, 5, 21, 14, 0, 0)),
               "end_time": iso(datetime(2025, 5, 21, 15, 0, 0)),
               "duration": 3600, "fps": 25, "width": 2560, "height": 1440,
               "codec": "hevc", "src_codec": "hevc", "bitrate_kbps": 6000,
               "file_size_mb": 2637, "gop_sec": 4.0, "faststart": False},
              {"id": "CAM09", "name": "Camera9", "place_ko": "산책로",
               "node_id": 22002, "ch": 1, "status": "failed",
               "source_type": "uploaded", "has_proxy": False,
               "error": "CUDA out of memory (VRAM 8GB, 요구 11.4GB) — 배치 크기를 줄이거나 더 낮은 해상도로 재시도하십시오.",
               "start_time": iso(datetime(2025, 5, 21, 14, 0, 0)),
               "end_time": iso(datetime(2025, 5, 21, 18, 0, 0)),
               "duration": 14400, "fps": 30, "width": 3840, "height": 2160,
               "codec": "hevc", "src_codec": "hevc", "bitrate_kbps": 16000,
               "file_size_mb": 28125, "gop_sec": 4.0, "faststart": False}]}
    groups.append(a3)

    # --- Area4: analiz sürüyor / RTSP kayıtlı ------------------------------
    a4 = {"id": "G4", "name": "Area4", "name_ko": "시내 교차로", "desc": "진행 중 · RTSP",
          "cameras": [
              {"id": "CAM10", "name": "Camera10", "place_ko": "교차로 남측",
               "node_id": 23001, "ch": 0, "status": "analyzing",
               "source_type": "file", "has_proxy": False, "progress": 43,
               "stage": "candidate", "eta_sec": 262,
               "start_time": iso(datetime(2025, 5, 22, 7, 0, 0)),
               "end_time": iso(datetime(2025, 5, 22, 9, 0, 0)),
               "duration": 7200, "fps": 30, "width": 1920, "height": 1080,
               "codec": "h264", "src_codec": "h264", "bitrate_kbps": 5000,
               "file_size_mb": 4394, "gop_sec": 2.0, "faststart": True},
              {"id": "CAM11", "name": "Camera11", "place_ko": "교차로 북측 (RTSP)",
               "node_id": 23002, "ch": 0, "status": "registered",
               "source_type": "rtsp", "has_proxy": False,
               "rtsp_url": "rtsp://athena-vms.local:554/stream/23002/0",
               "start_time": None, "end_time": None,
               "duration": 0, "fps": 20, "width": 1920, "height": 1080,
               "codec": "hevc", "src_codec": "hevc", "bitrate_kbps": 4000,
               "file_size_mb": 0, "gop_sec": 2.0, "faststart": False}]}
    groups.append(a4)

    # --- Area5: gerçek SOLIDER veri seti -----------------------------------
    a5 = {"id": "G5", "name": "Area5", "name_ko": "실증 데이터셋 (실제 SOLIDER)",
          "desc": "fur/human · 실제 1024-d SOLIDER 임베딩 165건 + 실제 크롭 이미지",
          "real_data": True,
          "cameras": [
              {"id": "CAM20", "name": "Node20003", "place_ko": "실증 노드 20003",
               "node_id": 20003, "ch": 0, "status": "completed",
               "source_type": "archive", "has_proxy": False, "real_data": True,
               "start_time": iso(datetime(2024, 7, 1, 23, 35, 37)),
               "end_time": iso(datetime(2024, 7, 2, 2, 7, 41)),
               "duration": 9124, "fps": 15, "width": 1920, "height": 1080,
               "codec": "h264", "src_codec": "h264", "bitrate_kbps": 3000,
               "file_size_mb": 3345, "gop_sec": 2.0, "faststart": True}]}
    groups.append(a5)

    # -- DB semasina gore zenginlestirme ------------------------------------
    # camera / camera_group / video_asset tablolarindaki alanlar. Frontend
    # bunlarin cogunu dogrudan kullanmasa da sozlesmede yer almalari gerekir:
    # public_id API'de id yerine gecer, lat/lon harita gorunumunu besler,
    # timezone duvar saati donusumunun dogruluk sartidir.
    geo = {  # 대전 유성구 civari — harita gorunumu icin makul koordinatlar
        "CAM01": (36.3745, 127.3610), "CAM02": (36.3752, 127.3618),
        "CAM03": (36.3739, 127.3625), "CAM04": (36.3748, 127.3603),
        "CAM05": (36.4102, 127.3891), "CAM06": (36.4108, 127.3902),
        "CAM07": (36.4095, 127.3910), "CAM08": (36.3512, 127.3788),
        "CAM09": (36.3505, 127.3801), "CAM10": (36.3320, 127.4210),
        "CAM11": (36.3327, 127.4218), "CAM20": (36.3801, 127.3560),
    }
    for gi, g in enumerate(groups):
        g["public_id"] = pid("camera_group", g["id"])
        g["display_order"] = gi
        for ci_, c in enumerate(g["cameras"]):
            lat, lon = geo.get(c["id"], (36.3745, 127.3610))
            c["public_id"] = pid("camera", c["id"])
            c["video_public_id"] = pid("video_asset", c["id"])
            c["latitude"] = lat
            c["longitude"] = lon
            c["timezone"] = "Asia/Seoul"      # duvar saati donusumunun kaynagi
            c["is_active"] = c["status"] != "deleted"
            c["display_order"] = ci_
            c["location_name"] = c.get("place_ko", "")
            c["source_uri"] = c.get("rtsp_url") or f"file:///archive/{c['id']}.mp4"
            c["container_format"] = "mp4"
            c["duration_ms"] = int(round(c["duration"] * 1000))
            c["frame_count"] = int(round(c["duration"] * c["fps"]))
            # FFmpeg time_base — frame_index tablosundaki pts/dts bu olcekte
            c["time_base_num"] = 1
            c["time_base_den"] = 90000
            c["checksum_sha256"] = pid("sha", c["id"]).replace("-", "") * 2
    return groups


# ---------------------------------------------------------------------------
# Aday구간 선정 (Plan 1) — kural tabanlı ihlal skorları
# ---------------------------------------------------------------------------

def build_candidates(tracks, duration, fps):
    """Track verisinden pencere başına metrik skorları üretir.

    Plan 1'in akış şemasındaki analiz kollarının uygulaması. Gerçek motorda
    bu hesaplar optical flow ve Kalman durumları üzerinden yapılır; burada
    aynı büyüklükler doğrudan yörüngelerden türetiliyor.

    Dönen yapı DB'deki `event_candidate_score` satırlarına birebir karşılık
    gelir: (start/end, metric_code, score, threshold, details).
    """
    W = WINDOW_SEC_CAND
    n = max(1, int(math.ceil(duration / W)))

    def boxes_at(t):
        out = []
        for tr in tracks:
            bb = tr.at(t)
            if bb:
                out.append((tr, bb))
        return out

    # Önce ham büyüklükleri topla, sonra videonun kendi normaline göre ölçekle
    raw = []
    prev_ids = set()
    for i in range(n):
        t0, t1 = i * W, min(duration, (i + 1) * W)
        samples = [t0 + k * (t1 - t0) / 4 for k in range(5)]
        ids, area_sum, speed, ratio_delta, min_dist, counts = set(), 0.0, 0.0, 0.0, 9.9, []
        dwell_hits = 0
        for si, t in enumerate(samples):
            bs = boxes_at(t)
            counts.append(len(bs))
            for tr, (x1, y1, x2, y2) in bs:
                ids.add(tr.tid)
                area_sum += (x2 - x1) * (y2 - y1)
                # hız: 0.2 sn'lik farktan
                p = tr.at(max(0, t - 0.2))
                if p:
                    cx0, cy0 = (p[0] + p[2]) / 2, (p[1] + p[3]) / 2
                    cx1, cy1 = (x1 + x2) / 2, (y1 + y2) / 2
                    speed = max(speed, math.hypot(cx1 - cx0, cy1 - cy0) / 0.2)
                    # en/boy oranı değişimi → duruş değişimi (쓰러짐)
                    r0 = (p[3] - p[1]) / max(1e-6, p[2] - p[0])
                    r1 = (y2 - y1) / max(1e-6, x2 - x1)
                    ratio_delta = max(ratio_delta, abs(r1 - r0) / max(r0, 1e-6))
                    if math.hypot(cx1 - cx0, cy1 - cy0) < 0.004:
                        dwell_hits += 1
            for ai in range(len(bs)):
                for bi in range(ai + 1, len(bs)):
                    (_, A), (_, B) = bs[ai], bs[bi]
                    d = math.hypot((A[0]+A[2])/2 - (B[0]+B[2])/2,
                                   (A[1]+A[3])/2 - (B[1]+B[3])/2)
                    min_dist = min(min_dist, d)
        churn = len(ids ^ prev_ids)
        prev_ids = ids
        raw.append({
            "t0": round(t0, 2), "t1": round(t1, 2),
            "pixel_change": area_sum / max(1, len(samples)),
            "motion_change": speed,
            "object_count": max(counts) - min(counts),
            "track_churn": churn,
            "interaction": (1.0 - min(min_dist, 1.0)) if min_dist < 9 else 0.0,
            "dwell": dwell_hits / max(1, len(samples) * max(1, len(ids))),
            "posture": ratio_delta,
        })

    # Her metriği kendi dağılımına göre 0~1'e ölçekle (motor da böyle yapar:
    # "평상시보다 큰가?" sorusu mutlak eşik değil, göreli eşik demektir)
    windows = []
    for key in METRICS:
        vals = np.array([r[key] for r in raw], dtype=np.float32)
        lo = float(np.percentile(vals, 30))
        hi = float(np.percentile(vals, 97)) or 1.0
        for r in raw:
            r[key + "_n"] = float(np.clip((r[key] - lo) / max(1e-6, hi - lo), 0, 1))

    for r in raw:
        scores = []
        total = 0.0
        for code, m in METRICS.items():
            sc = round(r[code + "_n"], 4)
            total += sc * m["w"]
            scores.append({
                "metric_code": code,
                "score": sc,
                "threshold": m["thr"],
                "exceeded": sc >= m["thr"],
                "details": {"raw": round(r[code], 5), "weight": m["w"]},
            })
        total = round(min(1.0, total / sum(m["w"] for m in METRICS.values())
                          * 1.6), 4)
        windows.append({
            "t_start": r["t0"], "t_end": r["t1"],
            "start_timestamp_ms": int(r["t0"] * 1000),
            "end_timestamp_ms": int(r["t1"] * 1000),
            "integrated_score": total,
            "threshold": CANDIDATE_THRESHOLD,
            "is_candidate": total >= CANDIDATE_THRESHOLD,
            "top_metric": max(scores, key=lambda x: x["score"])["metric_code"],
            "scores": scores,
        })
    return windows


# ---------------------------------------------------------------------------
# Re-ID embedding'leri
# ---------------------------------------------------------------------------

def load_real_embeddings():
    """fur/human içindeki gerçek SOLIDER vektörlerini ve kırpma görüntülerini alır."""
    db = HUMAN / "person_embedding.db"
    sdb = HUMAN / "search_db"
    if not db.exists():
        print(f"  [!] {db} bulunamadi — gercek Re-ID verisi atlaniyor")
        return [], np.zeros((0, 1024), dtype=np.float32)

    conn = sqlite3.connect(str(db))
    rows = conn.execute(
        "SELECT image_id, node_id, ch, detect_date, embedding "
        "FROM embeddings ORDER BY detect_date").fetchall()

    # image_id -> dosya adı eşlemesi
    id2file = {}
    for jf in sdb.glob("*.json"):
        try:
            d = json.loads(jf.read_text(encoding="utf-8"))
            id2file[str(d["image_id"])] = d["image_path"]
        except Exception:
            continue

    CROPS.mkdir(parents=True, exist_ok=True)
    items, vecs = [], []
    for image_id, node_id, ch, ddate, blob in rows:
        fname = id2file.get(str(image_id))
        if not fname:
            continue
        src = sdb / fname
        if not src.exists():
            continue
        dst = CROPS / f"real_{image_id}.jpg"
        if not dst.exists():
            shutil.copyfile(src, dst)
        v = np.frombuffer(blob, dtype=np.float32)
        if v.shape[0] != 1024:
            continue
        dt = datetime.fromisoformat(ddate)
        items.append({
            "id": f"R{image_id}", "kind": "real",
            "video_id": "CAM20", "camera": "Node20003",
            "camera_place": "실증 노드 20003",
            "group": "Area5",
            "track_id": int(image_id),
            "cls": "person",
            "crop": f"assets/crops/real_{image_id}.jpg",
            "node_id": int(node_id), "ch": int(ch),
            "wall_time": dt.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
            "t_first": 0.0, "t_last": 0.0,
            "conf": 0.9,
            "attrs": {},          # gerçek veride PAR yok
            "label": f"실증 #{image_id}",
        })
        vecs.append(v)
    if vecs:
        arr = np.stack(vecs).astype(np.float32)
    else:
        arr = np.zeros((0, 1024), dtype=np.float32)
    print(f"  gercek SOLIDER embedding: {arr.shape}")
    return items, arr


def synth_embedding(identity_seed, jitter=0.14, dim=1024):
    """Aynı identity_seed → yüksek kosinüs benzerliği veren vektör üretir."""
    rs = np.random.RandomState(identity_seed)
    base = rs.normal(0, 1, dim).astype(np.float32)
    base /= np.linalg.norm(base)
    noise = np.random.normal(0, 1, dim).astype(np.float32)
    noise -= noise.dot(base) * base
    noise /= (np.linalg.norm(noise) + 1e-9)
    v = base * math.cos(jitter) + noise * math.sin(jitter)
    return (v / np.linalg.norm(v)).astype(np.float32)


# Hangi track hangi kimliğe ait — Re-ID hikâyesinin iskeleti
IDENTITY = {
    ("CAM01", 1): 1001,      # P1 hedef kişi
    ("CAM02", 12): 1001,     # aynı kişi, farklı kamera → eşleşmeli
    ("CAM01", 2): 1002,
    ("CAM01", 3): 1003,
    ("CAM02", 13): 1004,
    ("CAM03", 21): 1005,
    ("CAM03", 22): 1006,
    ("CAM04", 31): 1007, ("CAM04", 32): 1008, ("CAM04", 33): 1009,
    ("CAM04", 34): 1010, ("CAM04", 35): 1011, ("CAM04", 36): 1012,
}
# Kasıtlı zorluk: P4 (CAM02/13) ile P2 (CAM01/2) biraz benzesin (yanlış pozitif adayı)
NEAR_MISS = {("CAM02", 13): (1002, 0.62)}


# ---------------------------------------------------------------------------
# Ana üretim
# ---------------------------------------------------------------------------

def main():
    print("== Mock veri uretimi ==")
    DATA.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    CROPS.mkdir(parents=True, exist_ok=True)

    groups = build_catalog()
    cam_index = {}
    for g in groups:
        for c in g["cameras"]:
            c["group_id"] = g["id"]
            c["group_name"] = g["name"]
            cam_index[c["id"]] = c

    all_objects = []
    all_vecs = []
    render_payload = {}

    # ---- Area1 kameraları: tam veri ---------------------------------------
    for cid, fn in SCENARIOS.items():
        tracks, concepts = fn()
        cam = cam_index[cid]
        fps = cam["fps"]
        dur = cam["duration"]
        start_dt = datetime.fromisoformat(cam["start_time"].replace("+09:00", ""))

        # -- detections (kompakt satır formatı) -----------------------------
        rows = []
        nframes = int(dur * fps)
        for f in range(nframes):
            t = round(f / fps, 3)
            for tr in tracks:
                box = tr.at(t)
                if box is None:
                    continue
                x1, y1, x2, y2 = box
                if x2 <= 0.001 or x1 >= 0.999 or (y2 - y1) < 0.01:
                    continue
                # DB şeması: bbox_x / bbox_y / bbox_width / bbox_height,
                # hepsi numeric(10,7) ve "0~1 정규화" notlu.
                # Kablo formatı da aynı olsun — frontend dönüşümü kendi yapar.
                rows.append([t, tr.tid, 0 if tr.cls == "person" else 1,
                             tr.conf(t), x1, y1,
                             round(x2 - x1, 7), round(y2 - y1, 7)])

        # -- nesne listesi (crop kartları) ----------------------------------
        objs = []
        for tr in tracks:
            ident = IDENTITY.get((cid, tr.tid), 9000 + tr.tid)
            oid = f"{cid}-O{tr.tid}"
            tmid = (tr.t0 + tr.t1) / 2
            objs.append({
                "id": oid, "kind": "synthetic",
                # şema: track tablosu
                "public_id": pid("track", oid),
                "local_track_no": tr.tid,
                "mean_confidence": tr.conf(tmid),
                "first_timestamp_ms": int(tr.t0 * 1000),
                "last_timestamp_ms": int(tr.t1 * 1000),
                "global_identity_id": None,     # Re-ID onaylanınca dolar
                "video_id": cid, "camera": cam["name"],
                "camera_place": cam["place_ko"], "group": cam["group_name"],
                "track_id": tr.tid, "cls": tr.cls,
                "crop": f"assets/crops/{cid}_T{tr.tid}.jpg",
                "node_id": cam["node_id"], "ch": cam["ch"],
                "wall_time": iso(start_dt + timedelta(seconds=tmid)),
                "t_first": round(tr.t0, 2), "t_last": round(tr.t1, 2),
                "conf": tr.conf(tmid),
                "attrs": tr.attrs,
                "label": tr.label or oid,
                "identity": ident,     # sadece mock doğrulaması için
            })
            all_objects.append(objs[-1])
            if tr.cls == "person":
                key = (cid, tr.tid)
                if key in NEAR_MISS:
                    other, blend = NEAR_MISS[key]
                    v1 = synth_embedding(ident, 0.10)
                    v2 = synth_embedding(other, 0.10)
                    v = v1 * blend + v2 * (1 - blend)
                    v /= np.linalg.norm(v)
                else:
                    v = synth_embedding(ident, 0.16)
            else:
                v = synth_embedding(ident, 0.20)
            all_vecs.append(v)

        # -- aday구간 skorları (Plan 1) ---------------------------------------
        cands = build_candidates(tracks, dur, fps)

        # -- olaylar ---------------------------------------------------------
        evs = []
        SEV_NUM = {"info": 1, "warn": 2, "critical": 3}
        for i, (t0, t1, ko, en, etype, score, tids) in enumerate(EVENTS[cid]):
            eid = f"{cid}-E{i+1}"
            gid = EVENT_OF_GROUP.get(eid)
            evs.append({
                "id": eid,
                "public_id": pid("vlm_event", eid),
                "video_id": cid,
                "camera_id": cam["public_id"],
                # --- şema alanları -----------------------------------------
                "event_group_id": pid("event_group", gid) if gid else None,
                "event_group_code": gid,
                "event_group_title": EVENT_GROUP_TITLE.get(gid),
                "status": "candidate",          # event_status enum
                "severity_level": SEV_NUM[EVENT_TYPE_META[etype]["sev"]],
                "start_timestamp_ms": int(t0 * 1000),
                "end_timestamp_ms": int(t1 * 1000),
                "occurred_start_at": iso(start_dt + timedelta(seconds=t0)),
                "occurred_end_at": iso(start_dt + timedelta(seconds=t1)),
                "title": ko[:40],
                # --- UI kolaylığı (saniye cinsinden) ------------------------
                "t_start": t0, "t_end": t1,
                "wall_start": iso(start_dt + timedelta(seconds=t0)),
                "wall_end": iso(start_dt + timedelta(seconds=t1)),
                "type": etype,
                "type_ko": EVENT_TYPE_META[etype]["ko"],
                "type_tr": EVENT_TYPE_META[etype]["tr"],
                "severity": EVENT_TYPE_META[etype]["sev"],
                "color": EVENT_TYPE_META[etype]["color"],
                "description": ko, "description_en": en,
                "score": score,
                "track_ids": tids,
                "thumbnail": f"assets/thumbs/{cid}_E{i+1}.jpg",
                "vlm_model": "InternVL2-8B",
                "vlm_latency_ms": random.randint(1100, 2600),
            })

        # -- özet video segment eşlemesi -------------------------------------
        # (요약 영상: olaylı bölümlerin arka arkaya eklenmiş hali)
        sum_segments, cursor = [], 0.0
        for e in sorted(evs, key=lambda x: x["t_start"]):
            if e["t_end"] - e["t_start"] > 90:      # çok uzun olayı kırp
                seg_dur = 20.0
                src_s = e["t_start"]
            else:
                seg_dur = min(24.0, e["t_end"] - e["t_start"] + 4)
                src_s = max(0.0, e["t_start"] - 2)
            sum_segments.append({
                "sum_start": round(cursor, 2),
                "sum_end": round(cursor + seg_dur, 2),
                "src_video_id": cid,
                "src_start": round(src_s, 2),
                "src_end": round(src_s + seg_dur, 2),
                "event_id": e["id"],
            })
            cursor += seg_dur

        summary = {
            "video_id": cid,
            "duration": dur,
            "summary_duration": round(cursor, 1),
            "ratio": round(cursor / dur * 100, 1),
            "main_objects": [
                {"cls": "person", "ko": "사람",
                 "count": sum(1 for t in tracks if t.cls == "person")},
                {"cls": "vehicle", "ko": "차량",
                 "count": sum(1 for t in tracks if t.cls == "vehicle")}],
            "event_count": len(evs),
            "generated_at": iso(start_dt + timedelta(hours=15, minutes=15)),
            "engine_version": "vsum-engine 0.4.2",
            "models": {"detector": "YOLOv11-x", "tracker": "BoT-SORT",
                       "par": "PAR-Swin-B", "reid": "SOLIDER (swin_base, 1024-d)",
                       "vlm": "InternVL2-8B"},
            "segments": sum_segments,
            "prompt_used": None,
        }

        payload = {
            "video": cam,
            "summary": summary,
            "events": evs,
            "objects": objs,
            "detections": {
                "fps": fps,
                "coord": "normalized_xywh",
                "keys": ["t", "track_id", "cls", "conf",
                         "bbox_x", "bbox_y", "bbox_width", "bbox_height"],
                "cls_map": {"0": "person", "1": "vehicle"},
                "rows": rows,
            },
            "candidates": {
                "window_sec": WINDOW_SEC_CAND,
                "threshold": CANDIDATE_THRESHOLD,
                "metrics": METRICS,
                "count": len(cands),
                "selected": sum(1 for w in cands if w["is_candidate"]),
                "windows": cands,
            },
        }
        (DATA / f"video_{cid}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(f"  {cid}: {len(rows)} bbox, {len(evs)} olay, "
              f"{len(cands)} pencere ({sum(1 for w in cands if w['is_candidate'])} aday), "
              f"{len(objs)} nesne")

        render_payload[cid] = {
            "style": SCENE_STYLE[cid],
            "fps": fps, "duration": dur, "w": VIDEO_W, "h": VIDEO_H,
            "start_time": cam["start_time"],
            "place": cam["place_ko"], "name": cam["name"],
            "tracks": [{
                "tid": t.tid, "cls": t.cls, "aspect": t.aspect,
                "attrs": t.attrs,
                "wp": [[round(a, 3), b, c, d] for (a, b, c, d) in t.waypoints],
            } for t in tracks],
            "events": [{"t0": e["t_start"], "t1": e["t_end"],
                        "id": e["id"], "type": e["type"]} for e in evs],
        }

    # ---- Area2 (24 saat, video yok) — sadece olay + segment ----------------
    for cid in ["CAM05", "CAM06", "CAM07"]:
        cam = cam_index[cid]
        dur = cam["duration"]
        start_dt = datetime.fromisoformat(cam["start_time"].replace("+09:00", ""))
        rnd = random.Random(hash(cid) & 0xffff)
        evs = []
        templates = [
            ("loiter", "야간 시간대에 특정 인원이 창고 주변을 반복적으로 이동"),
            ("enter", "지게차가 하역장으로 진입"),
            ("abandon", "적재물이 통로에 방치된 상태로 관측됨"),
            ("crowd", "작업 인원이 동시에 다수 이동"),
            ("vehicle", "화물 차량이 하역장에 정차"),
            ("exit", "화물 차량이 구역을 이탈"),
            ("fall", "작업자가 적재물 옆에서 넘어짐"),
            ("fire_smoke", "B동 후면에서 미세한 연기 형태의 변화가 감지됨"),
        ]
        n = rnd.randint(28, 46)
        for i in range(n):
            t0 = rnd.uniform(0, dur - 60)
            etype, desc = rnd.choice(templates)
            sev = EVENT_TYPE_META[etype]["sev"]
            if sev == "critical" and rnd.random() > 0.25:
                etype, desc = "walk", "인원이 통로를 따라 이동"
            t1_ = round(t0 + rnd.uniform(8, 55), 1)
            evs.append({
                "id": f"{cid}-E{i+1}", "video_id": cid,
                "public_id": pid("vlm_event", f"{cid}-E{i+1}"),
                "camera_id": cam["public_id"],
                "event_group_id": None, "event_group_code": None,
                "event_group_title": None,
                "status": "candidate",
                "severity_level": {"info": 1, "warn": 2,
                                   "critical": 3}[EVENT_TYPE_META[etype]["sev"]],
                "start_timestamp_ms": int(t0 * 1000),
                "end_timestamp_ms": int(t1_ * 1000),
                "occurred_start_at": iso(start_dt + timedelta(seconds=t0)),
                "occurred_end_at": iso(start_dt + timedelta(seconds=t1_)),
                "title": desc[:40],
                "t_start": round(t0, 1), "t_end": t1_,
                "wall_start": iso(start_dt + timedelta(seconds=t0)),
                "wall_end": iso(start_dt + timedelta(seconds=t0 + 30)),
                "type": etype, "type_ko": EVENT_TYPE_META[etype]["ko"],
                "type_tr": EVENT_TYPE_META[etype]["tr"],
                "severity": EVENT_TYPE_META[etype]["sev"],
                "color": EVENT_TYPE_META[etype]["color"],
                "description": desc, "description_en": "",
                "score": round(rnd.uniform(0.52, 0.95), 2),
                "track_ids": [], "thumbnail": None,
                "vlm_model": "InternVL2-8B",
                "vlm_latency_ms": rnd.randint(900, 2800),
            })
        evs.sort(key=lambda e: e["t_start"])

        # 24 saatlik videoda pencere sayısı 43.200 olurdu — UI'ya bunu
        # göndermek anlamsız. Motor hepsini hesaplar, API seyreltilmiş
        # (veya yalnızca aday olan) pencereleri döner.
        rnd2 = random.Random(hash(cid) & 0x7fff)
        cands = []
        big_window = 60.0
        nw = int(dur // big_window)
        for i in range(nw):
            t0 = i * big_window
            near = min((abs(e["t_start"] - t0) for e in evs), default=9e9)
            base = 0.62 if near < 40 else rnd2.uniform(0.05, 0.34)
            total = round(min(1.0, base + rnd2.uniform(-0.06, 0.10)), 4)
            code = rnd2.choice(list(METRICS.keys()))
            cands.append({
                "t_start": t0, "t_end": t0 + big_window,
                "start_timestamp_ms": int(t0 * 1000),
                "end_timestamp_ms": int((t0 + big_window) * 1000),
                "integrated_score": total,
                "threshold": CANDIDATE_THRESHOLD,
                "is_candidate": total >= CANDIDATE_THRESHOLD,
                "top_metric": code,
                "scores": [{"metric_code": k, "score": round(
                    total if k == code else rnd2.uniform(0, total), 3),
                    "threshold": m["thr"],
                    "exceeded": (k == code and total >= m["thr"]),
                    "details": {}} for k, m in METRICS.items()],
            })

        payload = {
            "video": cam,
            "summary": {
                "video_id": cid, "duration": dur,
                "summary_duration": round(len(evs) * 14.0, 1),
                "ratio": round(len(evs) * 14.0 / dur * 100, 2),
                "main_objects": [{"cls": "person", "ko": "사람", "count": rnd.randint(40, 180)},
                                 {"cls": "vehicle", "ko": "차량", "count": rnd.randint(5, 40)}],
                "event_count": len(evs),
                "generated_at": iso(start_dt + timedelta(days=1, hours=3)),
                "engine_version": "vsum-engine 0.4.2",
                "models": {"detector": "YOLOv11-x", "tracker": "BoT-SORT",
                           "par": "PAR-Swin-B", "reid": "SOLIDER (swin_base, 1024-d)",
                           "vlm": "InternVL2-8B"},
                "segments": [], "prompt_used": None,
            },
            "events": evs, "objects": [],
            "detections": {"fps": cam["fps"], "coord": "normalized_xywh",
                           "keys": ["t", "track_id", "cls", "conf",
                                    "bbox_x", "bbox_y",
                                    "bbox_width", "bbox_height"],
                           "cls_map": {"0": "person", "1": "vehicle"}, "rows": []},
            "candidates": {"window_sec": big_window,
                           "threshold": CANDIDATE_THRESHOLD,
                           "metrics": METRICS, "count": len(cands),
                           "selected": sum(1 for w in cands if w["is_candidate"]),
                           "note": "24시간 영상 — 60초 단위로 축약된 뷰",
                           "windows": cands},
        }
        (DATA / f"video_{cid}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(f"  {cid}: 24s, {len(evs)} olay, {len(cands)} pencere (60s'lik)")

    # ---- Gerçek SOLIDER verisi --------------------------------------------
    real_items, real_vecs = load_real_embeddings()
    if real_items:
        cam = cam_index["CAM20"]
        (DATA / "video_CAM20.json").write_text(json.dumps({
            "video": cam,
            "summary": {"video_id": "CAM20", "duration": cam["duration"],
                        "summary_duration": 0, "ratio": 0,
                        "main_objects": [{"cls": "person", "ko": "사람",
                                          "count": len(real_items)}],
                        "event_count": 0,
                        "generated_at": iso(datetime(2024, 7, 2, 3, 0, 0)),
                        "engine_version": "person_search_system/prototype_3",
                        "models": {"reid": "SOLIDER (swin_base, 1024-d, 384x128)"},
                        "segments": [], "prompt_used": None},
            "events": [], "objects": real_items,
            "detections": {"fps": 15, "coord": "normalized_xywh",
                           "keys": ["t", "track_id", "cls", "conf",
                                    "bbox_x", "bbox_y",
                                    "bbox_width", "bbox_height"],
                           "cls_map": {"0": "person", "1": "vehicle"}, "rows": []},
            "candidates": {"window_sec": WINDOW_SEC_CAND,
                           "threshold": CANDIDATE_THRESHOLD,
                           "metrics": METRICS, "count": 0,
                           "selected": 0, "windows": []},
        }, ensure_ascii=False), encoding="utf-8")

    # ---- Embedding galerisi (sentetik + gerçek) ----------------------------
    gallery = all_objects + real_items
    if all_vecs:
        synth = np.stack(all_vecs).astype(np.float32)
    else:
        synth = np.zeros((0, 1024), dtype=np.float32)
    if real_vecs.shape[0]:
        mat = np.vstack([synth, real_vecs])
    else:
        mat = synth
    mat.astype(np.float32).tofile(DATA / "embeddings.f32")
    (DATA / "gallery.json").write_text(json.dumps({
        "dim": int(mat.shape[1]) if mat.shape[0] else 1024,
        "count": int(mat.shape[0]),
        "model": "SOLIDER swin_base (real) / synthetic (scenario)",
        "items": gallery,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"  galeri: {mat.shape[0]} vektor "
          f"({synth.shape[0]} sentetik + {real_vecs.shape[0]} gercek)")

    # ---- Katalog, öznitelikler, log, GPU -----------------------------------
    (DATA / "catalog.json").write_text(json.dumps({
        "groups": groups,
        "enums": {
            "video_source_type": SOURCE_TYPE,
            "video_status": VIDEO_STATUS,
            "analysis_run_status": ANALYSIS_RUN_STATUS,
            "event_status": EVENT_STATUS,
            "identity_match_status": IDENTITY_MATCH_STATUS,
            # geriye uyumluluk
            "source_type": SOURCE_TYPE,
        },
        "event_types": EVENT_TYPE_META,
        "event_groups": {gid: {"title": EVENT_GROUP_TITLE[gid],
                               "public_id": pid("event_group", gid),
                               "event_ids": ids}
                         for gid, ids in EVENT_GROUPS.items()},
        "window": {"start": iso(WINDOW_START), "sec": WINDOW_SEC},
        "schema_version": "video_analytics_schema_v2",
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    (DATA / "attributes.json").write_text(json.dumps({
        "attributes": ATTRIBUTES,
        "note": "UI filtre paneli bu listeden üretilir; sabit kodlanmaz.",
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    (DATA / "metrics.json").write_text(json.dumps({
        "metrics": METRICS,
        "window_sec": WINDOW_SEC_CAND,
        "threshold": CANDIDATE_THRESHOLD,
        "note": "event_candidate_score.metric_code sözlüğü — "
                "UI aday구간 grafiğini ve 'bu olay neden seçildi' "
                "açıklamasını buradan üretir.",
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    # log kayıtları
    logs = []
    lt = WINDOW_START + timedelta(hours=14)
    lines = [
        ("INFO", "engine", "요약 엔진 시작 (vsum-engine 0.4.2)"),
        ("INFO", "gpu", "CUDA device 0: NVIDIA GeForce RTX 5070 (12288 MiB)"),
        ("INFO", "model", "YOLOv11-x 로드 완료 (1.8s)"),
        ("INFO", "model", "BoT-SORT 초기화"),
        ("INFO", "model", "PAR-Swin-B 로드 완료 (2.1s)"),
        ("INFO", "model", "SOLIDER swin_base 로드 완료 (3.4s) — 임베딩 차원 1024"),
                ("INFO", "job", "job#8841 시작 — CAM01 (180.0s, 10fps)"),
        ("INFO", "stage", "[1/5] 디코딩 및 프레임 추출"),
        ("INFO", "stage", "[2/5] Object Detection + Tracking"),
        ("WARN", "detect", "CAM01 t=71.2s — 낮은 신뢰도 검출 3건 폐기 (conf<0.35)"),
        ("INFO", "stage", "[3/5] PAR 속성 추출 (4 tracks)"),
        ("INFO", "stage", "[4/5] Re-ID 임베딩 추출 (SOLIDER)"),
        ("INFO", "stage", "[5/5] 이벤트 후보 구간 선정 (90 windows → 12 candidates)"),
        ("INFO", "job", "job#8841 완료 — 소요 42.6s"),
        ("INFO", "job", "job#8842 시작 — CAM02"),
        ("ERROR", "job", "job#8850 실패 — CAM09: CUDA out of memory "
                         "(요구 11.4GB / 가용 8.0GB)"),
        ("WARN", "vms", "Athena VMS 연결 지연 (1420ms) — node 23002"),
        ("INFO", "vlm", "InternVL2-8B 추론 30 세그먼트 — 평균 1.8s/세그먼트"),
        ("INFO", "api", "GET /api/videos/CAM01/detections?from=0&to=30 → 200 (18ms)"),
    ]
    for i, (lvl, comp, msg) in enumerate(lines):
        logs.append({"ts": iso(lt + timedelta(seconds=i * 17)),
                     "level": lvl, "component": comp, "message": msg})
    (DATA / "logs.json").write_text(json.dumps({"logs": logs},
                                               ensure_ascii=False, indent=1),
                                    encoding="utf-8")

    (DATA / "render.json").write_text(json.dumps(render_payload,
                                                 ensure_ascii=False),
                                      encoding="utf-8")

    print("== Bitti ==")
    print(f"  {DATA}")


if __name__ == "__main__":
    main()
