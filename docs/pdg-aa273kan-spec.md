# Kyoto City Bus PDG-AA273KAN Specification & 3-View Geometry Reference

> **Purpose**: Authoritative vehicle specification and 3-view coordinate reference for **Kyoto City Bus (京都市営バス) Mitsubishi Fuso Aero Star-S (`PDG-AA273KAN`)**, mapped into the game coordinate system used by [`tools/bus-model.blend`](file:///Users/basalt/work/cc_sample_game/tools/bus-model.blend), [`src/bus/busModel.js`](file:///Users/basalt/work/cc_sample_game/src/bus/busModel.js), and [`src/config.js`](file:///Users/basalt/work/cc_sample_game/src/config.js).
>
> **Data Provenance Note**: Manufacturer/MLIT dimensions (overall length, width, total height by HVAC vendor, wheelbase, engine output, curb weight, passenger capacity, tire outer diameter) and Kyoto City Bus fleet records are verified from Japanese bus registries and manufacturer specifications. Individual body-panel millimeter coordinates (e.g., exact window bay splits, lamp housings, and overhang split) are not publicly released by Nishinippon Shatai Kogyo (西工); where exact factory CAD drawings are unavailable, values are derived from verified K-shaku chassis dimensions, MLIT non-step bus standards, and 96MC B-I proportions (marked as *derived/approx.*).

---

## 1. Kyoto City Bus `PDG-AA273KAN` Fleet Profile

| Item | Specification |
| :--- | :--- |
| **Model Designation** | **PDG-AA273KAN** (Mitsubishi Fuso **Aero Star-S**, K-shaku short wheelbase) |
| **OEM Base** | Nissan Diesel (UD Trucks) **Space Runner RA** (`PDG-RA273KAN`) OEM supply to Mitsubishi Fuso |
| **Emissions Compliance** | 平成17年排出ガス規制（新長期規制 / `PDG-`）適合・尿素SCR (`FLENDS`) 搭載 |
| **Body** | **西日本車体工業（西工）96MC B-I型** (`B-I`: flat horizontal lower windshield edge; *not* B-II sloped edge) |
| **Procurement / Registration** | **FY2007 (平成19年度)** batch, registered **January–February 2008** (**15 vehicles total**) |
| **Engine** | Nissan Diesel **MD92TJ** inline-6 SOHC 24V intercooled turbo diesel, **9,203 cc**, **220 kW (300 PS) @ 2,200 rpm**, **1,324 N·m (135 kgf·m) @ 1,400 rpm**, vertical upright offset rear-engine mount |
| **Transmission** | **ZF ECOMAT 5-speed torque-converter AT** (トルコン式5速AT; manual 5MT variants were `PKG-AA274`) |
| **Curb Weight / Capacity** | **9,790 kg** / **79 passengers** (MLIT 5AT fuel-economy filing) |
| **Front Door (前扉)** | **Glide-slide door (グライドスライドドア)** — Kyoto City Bus 96MC non-step standard; swings outward slightly and slides forward, flush when closed (single-leaf wide panel with upper + lower glass) |
| **Middle Door (中扉)** | **Wide sliding door (広幅引戸)**, rail-less push-pull lower edge, wheelchair ramp equipped |
| **Rear Emergency Exit** | **Right-side rear hinged door (非公式側後部・非常口)** with upper window |
| **Side Windows** | **Reverse-T sash (逆T字窓)** — upper split sliding vent + lower fixed bronze-tinted pane — plus **narrow fixed window directly behind the driver's seat** (PDG-era RA/AA273 signature) |
| **Kyoto Signature Features** | **Curb-side front safety window (セーフティウインドウ / 視野拡大窓)** below left A-pillar; **front turn signals relocated to front bumper corners**; originally **roll-sign destination curtains (幕式)** (updated to black-background curtains in Mar 2014; later retrofitted to full-color LED on many units from 2020+, e.g., Lecip at Nishigamo, Oji at Yokooji) |

### Fleet Allocation & HVAC Sub-Variants (15 Vehicles)

| Depot (新製配置) | Fleet Numbers (京都200か) | Count | Roof HVAC Vendor | Total Height | Notes / Route Relevance |
| :--- | :--- | :---: | :--- | :---: | :--- |
| **横大路営業所（阪急バス委託）** *(Yokooji, Hankyu Bus contracted)* | `1771`, `1772`, `1777`, `1778`, `1779` | 5 | **Thermo King** (サーモキング) | **2.990 m** | Equipped as multi-zone fare (`整理券車`) units; Yokooji (Hankyu Bus) operates **Route 18 (18号系統)** (`二条駅西口〜久我石原町`). `1771` converted to flat-fare (`単区間車`) in Mar 2026. |
| **西賀茂営業所（直営 / 京都バス委託）** *(Nishigamo)* | `1768`, `1769`, `1770`, `1773`, `1774`, `1775`, `1776`, `1783`, `1784`, `1785` | 10 | **Denso** (デンソー) | **3.040 m** | Routes 1, 4, 9, 37, 46, etc. `1785` ("one-star bus") retired Feb 5, 2026. |

> **Disambiguation of Neighboring Fleet Numbers** (do not confuse with `PDG-AA273KAN`):
> - `1683–1688+` (late 2007): **PDG-AA273MAN** (M-shaku: WB `5.300 m`, overall length `10.990 m`).
> - `1780–1782`, `1786`: Not Kyoto City Bus (`1782` = Keihan Bus Aero Ace; `1786` = former Keihan Kyoto Kotsu).
> - `1787–1793`: Isuzu Erga / 西工 96MC one-step (**PDG-LV234L2**, Karasuma Depot).
> - `2061`, `2079` (2009): Nissan Diesel Space Runner RA (**PDG-RA273KAN**, not Fuso `AA273KAN`); `2060`, `2080` are not Kyoto City Bus.

---

## 2. Exact Dimensions (Meters)

| Dimension | `PDG-AA273KAN` Spec | Current Game (`CFG.bus` / `bus.glb`) | Source / Status |
| :--- | :--- | :--- | :--- |
| **Overall Length (`全長`)** | **10.490 m** (10,490 mm) | `10.29 m` (body) / `10.53 m` (bumpers) | Verified (Fuso / UD catalog) |
| **Overall Width (`全幅`)** | **2.490 m** (2,490 mm) | `2.49 m` | Verified (Fuso / UD catalog) |
| **Roof Crown Height (body only)** | **~2.860 m** *(approx. 2.82–2.86 m)* | `3.00 m` (`Roof` max Y) | Derived from total height minus HVAC fairing |
| **Total Height — Thermo King (`全高`)** | **2.985 – 2.990 m** (2,985 mm catalog / 2,990 mm TK) | `3.14 m` (`RoofAC` max Y) | Verified (Fuso catalog / Kyoto TK spec) |
| **Total Height — Denso (`全高`)** | **3.040 m** (3,040 mm) | `3.14 m` (`RoofAC` max Y) | Verified (Kyoto Denso spec) |
| **Wheelbase (`ホイールベース`, K尺)** | **4.800 m** (4,800 mm) | `4.80 m` | Verified (Fuso / UD catalog) |
| **Total Overhang (`FOH + ROH`)** | **5.690 m** (`10.490 - 4.800`) | `5.49 m` (body) | Exact from length & WB |
| **Front Overhang (`前オーバーハング`)** | **~2.210 m** *(typical range 2.21–2.25 m)* | `2.34 m` (body) / `2.46 m` (bumper) | Derived (Space Runner RA K-shaku split) |
| **Rear Overhang (`後オーバーハング`)** | **~3.480 m** *(typical range 3.44–3.48 m)* | `3.15 m` (body) / `3.27 m` (bumper) | Derived (`5.690 - 2.210`) |
| **Front Tread (`前輪トレッド`)** | **~2.050 m** *(range 2.015–2.075 m)* | `2.151 m` (`X = ±1.0757`) | Typical large city-bus axle spec |
| **Rear Tread (`後輪トレッド`, dual center)** | **~1.835 m** *(range 1.825–1.850 m)* | `1.892 m` (`X = ±0.9462`) | Typical dual-tire axle spec |
| **Tire Size** | **275/70R22.5** (single front, dual rear) | — | Standard Japanese large non-step bus |
| **Tire Outer Diameter / Radius** | **0.959 m** dia / **0.4795 m** unloaded radius (**~0.460 m** loaded) | `0.460 m` radius (`0.92 m` dia) | Verified (Dunlop `275/70R22.5` spec) |
| **Front/Mid Non-Step Floor Height** | **0.320 – 0.350 m** normal (**~0.270 – 0.300 m** kneeling) | `0.45 – 0.55 m` (`Floor`) | Verified (MLIT non-step standard: ≤270 mm at entry w/ kneeling) |
| **Rear Stepped Floor Height** | **0.720 – 0.850 m** (2 steps ≤200 mm/step + slight rear slope) | flat `0.55 m` | Derived (MLIT step rule + MD92TJ offset engine) |
| **Minimum Turning Radius** | **~7.9 – 8.0 m** (outer front wheel) | kinematic `maxSteerDeg: 45°` | Space Runner RA K-shaku reference |
| **Approach / Departure Angles** | Not published in catalog; **~8°–9°** approach / **~5.5°–6°** departure | — | Geometrically derived from ~0.32 m apron clearance & overhangs |

---

## 3. 3-View Geometry Tables in Game Coordinate System

### Coordinate System & Baseline
Matches [`src/bus/busModel.js`](file:///Users/basalt/work/cc_sample_game/src/bus/busModel.js) and [`tools/bus-model.blend`](file:///Users/basalt/work/cc_sample_game/tools/bus-model.blend):
- **Origin `(0, 0, 0)`**: Ground plane (`Y = 0`) directly beneath the **REAR AXLE CENTER**.
- **`+X`**: Left / Curb / Passenger Door side (`公式側`). Outer body wall at `X = +1.245 m`.
- **`-X`**: Right / Driver side (`非公式側`). Outer body wall at `X = -1.245 m`.
- **`+Y`**: Up (`Y = 0` is ground).
- **`+Z`**: Forward. Front axle center at `Z = +4.800 m`; Front bumper tip at `Z = +7.010 m` (`FOH = 2.210 m`); Front body panel at `Z = +6.950 m`.
- **`-Z`**: Rear. Rear bumper tip at `Z = -3.480 m` (`ROH = 3.480 m`); Rear body panel at `Z = -3.420 m`.

> **Note on Current `bus.glb` Baseline**: The existing [`public/models/bus.glb`](file:///Users/basalt/work/cc_sample_game/public/models/bus.glb) models a `10.29 m` body (`Z = -3.15 .. +7.14 m`, bumpers `-3.27 .. +7.26 m`, `Roof` `2.94 .. 3.00 m`, `RoofAC` `3.14 m`) with a glide-slide-like flat front door, no safety window, and `SignSideL` mounted over the front door (`Z = +5.90 .. +7.10 m`). The tables below define the **target `PDG-AA273KAN` geometry** for updating `tools/bus-model.blend` and `src/config.js`.

---

### 3.1 Side Window Bays (Left Side `+X` & Right Side `-X`)

On Kyoto City Bus `PDG-AA273KAN` (96MC B-I), side passenger windows use **reverse-T sashes (`逆T字窓`)**:
- **Standard Sill `Y`**: `1.250 m` (raised slightly to `~1.350 m` in the rearmost engine bay if stepped, or uniform exterior sash line at `1.250 m`).
- **Standard Header `Y`**: `2.300 m` (total glazed height `1.050 m`).
- **Sash Proportions**:
  - **Lower fixed pane**: ~**70%** of glazed height (`Y = 1.250 .. 1.985 m`, `0.735 m` tall).
  - **Horizontal transom bar**: `Y = 1.985 .. 2.015 m` (`0.030 m` black/silver divider).
  - **Upper sliding vent sashes (two split panes)**: ~**27%** of glazed height (`Y = 2.015 .. 2.300 m`, `0.285 m` tall).

#### Left Side (`+X`, Curb / Door Side — `X = +1.210 .. +1.245 m`)
| Bay / Element | Z Start (m) | Z End (m) | Width (m) | Sill Y (m) | Header Y (m) | Type & Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Front Corner / Safety Window** | `+6.68` | `+6.95` | `0.27` | `0.58` | `1.14` | Curb-side lower viewing window (`セーフティウインドウ`); see §3.4 |
| **Front Door Opening** | `+5.58` | `+6.58` | `1.00` | `0.34` | `2.28` | Glide-slide door (see §3.2) |
| **Bay L-F1** (above front wheel) | `+4.50` | `+5.48` | `0.98` | `1.25` | `2.30` | Reverse-T sash; `SignSideL` mounted in upper band (`Z = +3.65..+4.95` spans L-F1/L-F2) |
| **Bay L-F2** (mid-front) | `+3.35` | `+4.40` | `1.05` | `1.25` | `2.30` | Reverse-T sash |
| **Middle Door Opening** | `+2.05` | `+3.25` | `1.20` | `0.34` | `2.28` | Wide sliding door (see §3.2) |
| **Bay L-R1** (door pocket bay) | `+0.45` | `+1.95` | `1.50` | `1.25` | `2.30` | Reverse-T sash (sliding door pocket sits inside/behind lower panel `Z = +0.85..+2.05`) |
| **Bay L-R2** (over rear axle) | `-1.30` | `+0.35` | `1.65` | `1.25` | `2.30` | Reverse-T sash |
| **Bay L-R3** (rearmost left) | `-3.28` | `-1.40` | `1.88` | `1.25` | `2.30` | Reverse-T sash (or fixed rear quarter over engine intake) |

#### Right Side (`-X`, Driver Side — `X = -1.245 .. -1.210 m`)
| Bay / Element | Z Start (m) | Z End (m) | Width (m) | Sill Y (m) | Header Y (m) | Type & Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Driver Window (`運転席窓`)** | `+5.25` | `+6.65` | `1.40` | `1.05` | `2.28` | Lower sill for driver visibility; horizontal sliding cab sash |
| **Post-Driver Fixed Window** | `+4.70` | `+5.18` | `0.48` | `1.25` | `2.30` | **Narrow fixed vertical window** directly behind driver partition (PDG-RA/AA273 signature) |
| **Bay R-1** | `+3.15` | `+4.62` | `1.47` | `1.25` | `2.30` | Reverse-T sash |
| **Bay R-2** | `+1.55` | `+3.07` | `1.52` | `1.25` | `2.30` | Reverse-T sash |
| **Bay R-3** (over rear axle) | `-0.05` | `+1.47` | `1.52` | `1.25` | `2.30` | Reverse-T sash |
| **Bay R-4** | `-1.65` | `-0.13` | `1.52` | `1.25` | `2.30` | Reverse-T sash |
| **Rear Emergency Exit (`非常口`)** | `-2.65` | `-1.75` | `0.90` | `0.78` (door) | `2.28` | Hinged emergency exit; upper glass `Y = 1.25 .. 2.25 m` |
| **Bay R-5** (rearmost right) | `-3.32` | `-2.73` | `0.59` | `1.35` | `2.30` | Fixed quarter window / engine intake louver bay |

---

### 3.2 Doors & Emergency Exit (`X = +1.18..+1.245` Left / `-1.245..-1.18` Right)

| Door | Side | Z Start (m) | Z End (m) | Frame Width (m) | Sill Y (m) | Top Y (m) | Leaf Configuration |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Front Door (`前扉`)** | Left (`+X`) | `+5.58` | `+6.58` | `1.00` (clear `~0.90`) | `0.34` | `2.28` | **Glide-slide (`グライドスライド`)**: single flush panel (`~0.96 m` wide) swinging out & sliding forward (`+Z`) beside A-pillar/safety window. Upper glass `Y = 1.25..2.22`, lower glass `Y = 0.45..1.15`. |
| **Middle Door (`中扉`)** | Left (`+X`) | `+2.05` | `+3.25` | `1.20` (clear `~1.05`) | `0.34` | `2.28` | **Single wide sliding (`広幅引戸`)**: 1 leaf (`1.18 m` wide), slides rearward (`-Z`) into `Z = +0.85..+2.05`. Upper glass `Y = 1.25..2.22`, lower sight glass optional/panel `Y = 0.42..1.18`. |
| **Emergency Exit (`非常口`)** | Right (`-X`) | `-2.65` | `-1.75` | `0.90` | `0.78` | `2.28` | Outward-hinged single leaf (`0.86 m` wide); glazed upper half `Y = 1.25..2.22`. |

---

### 3.3 Wheel Arch Cutouts & Wheel Center Positions

| Assembly | Center `(X, Y, Z)` (m) | Tire Outer Radius / Width (m) | Cutout Z Span (m) | Cutout Y Span (m) | Cutout X Depth (m) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **WheelFL** (front left) | `(+1.025, 0.460, +4.800)` | `R = 0.460` loaded (`0.480` unloaded) / `W = 0.275` | `+4.22 .. +5.38` | `0.00 .. 1.04` | `+0.84 .. +1.245` |
| **WheelFR** (front right) | `(-1.025, 0.460, +4.800)` | `R = 0.460` loaded (`0.480` unloaded) / `W = 0.275` | `+4.22 .. +5.38` | `0.00 .. 1.04` | `-1.245 .. -0.84` |
| **WheelRL** (rear left dual) | `(+0.918, 0.460, 0.000)` | `R = 0.460` loaded / dual `W ≈ 0.60` | `-0.58 .. +0.58` | `0.00 .. 1.04` | `+0.62 .. +1.245` |
| **WheelRR** (rear right dual) | `(-0.918, 0.460, 0.000)` | `R = 0.460` loaded / dual `W ≈ 0.60` | `-0.58 .. +0.58` | `0.00 .. 1.04` | `-1.245 .. -0.62` |

---

### 3.4 Bumpers, Windshield, Curb-Side Safety Window & Rear Window

| Feature | X Span (m) | Y Span (m) | Z Span (m) | Dimensions `(W × H × D)` (m) | Notes |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Front Bumper (`BumperF`)** | `-1.245 .. +1.245` | `0.28 .. 0.62` | `+6.91 .. +7.01` | `2.49 × 0.34 × 0.10` | Houses recessed fog lamps & bumper-mounted turn signals; license plate centered/offset at `Y ≈ 0.36..0.53` |
| **Rear Bumper (`BumperR`)** | `-1.245 .. +1.245` | `0.30 .. 0.64` | `-3.48 .. -3.38` | `2.49 × 0.34 × 0.10` | 3-piece wraparound steel/resin bumper |
| **Windshield (`Windshield`)** | `-1.180 .. +1.180` | `1.18 .. 2.32` | `+6.93 .. +6.97` | `2.36 × 1.14 × 0.04` | **96MC B-I flat horizontal sill** at `Y = 1.18 m` across full width; 2 bottom-pivoted wipers |
| **Safety Window (`セーフティウインドウ`)** | `+1.050 .. +1.245` | `0.58 .. 1.14` | `+6.68 .. +6.95` | `0.27 (wrap) × 0.56` | Lower-left curb corner below windshield/A-pillar; signature Kyoto City Bus safety feature |
| **Rear Window (`GlassRear`)** | `-0.950 .. +0.950` | `1.90 .. 2.38` | `-3.43 .. -3.40` | `1.90 × 0.48 × 0.03` | Centered above rear engine/radiator bay |

---

### 3.5 Roof HVAC Unit, Roof Crown & Roof Vents

| Feature | X Span (m) | Y Span (m) | Z Span (m) | Contour / Notes |
| :--- | :---: | :---: | :---: | :--- |
| **Roof Crown (`Roof`)** | `-1.245 .. +1.245` | `2.80 .. 2.86` | `-3.42 .. +6.95` | Gently cambered roof (`Y = 2.80` at cant rail, `2.86` at crown centerline) |
| **Roof HVAC — Thermo King** *(Yokooji / Route 18)* | `-0.860 .. +0.860` | `2.86 .. 2.99` | `+0.25 .. +2.95` | `1.72 × 0.13 × 2.70 m`; low-profile streamlined fairing; total bus height **2.990 m** |
| **Roof HVAC — Denso** *(Nishigamo)* | `-0.880 .. +0.880` | `2.86 .. 3.04` | `+0.18 .. +3.03` | `1.76 × 0.18 × 2.85 m`; taller rounded-rectangle housing; total bus height **3.040 m** |
| **Front Roof Vent (`RoofVentF`)** | `-0.300 .. +0.300` | `2.86 .. 2.96` | `+5.10 .. +5.70` | `0.60 × 0.10 × 0.60 m` push-up ventilation hatch ahead of HVAC |
| **Rear Roof Vent (`RoofVentR`)** | `-0.300 .. +0.300` | `2.86 .. 2.96` | `-1.60 .. -1.00` | `0.60 × 0.10 × 0.60 m` ventilation fan/hatch behind HVAC |

---

### 3.6 Exterior Lighting (Headlamps, Fog, Turn Signals, Markers, Tail Clusters)

| Lamp Group | Side(s) | X Span (m) | Y Span (m) | Z Span (m) | Spec / Arrangement |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Headlamps (Quad / Dual Pods)** | L & R | `±(0.72 .. 1.12)` | `0.68 .. 0.88` | `+6.94 .. +6.99` | 96MC rectangular 4-lamp bezel (outer low-beam, inner high-beam) |
| **Fog Lamps** | L & R | `±(0.66 .. 0.84)` | `0.38 .. 0.50` | `+6.98 .. +7.01` | Yellow/clear rectangular lamps recessed in front bumper |
| **Front Turn Signals (`バンパーウインカー`)** | L & R | `±(0.96 .. 1.18)` | `0.38 .. 0.52` | `+6.97 .. +7.01` | **Relocated to front bumper corners** (due to curb-side safety window on Kyoto spec) |
| **Side Turn Signal / Repeater** | L & R | `±1.245` | `0.65 .. 0.75` | `+3.95 .. +4.10` | Amber side repeater behind front wheel arch (plus mid-body side marker near `Z ≈ +1.0`) |
| **Upper Corner Marker Lamps (Front / Rear)** | L & R | `±(1.12 .. 1.20)` | `2.75 .. 2.82` | `+6.94` / `-3.42` | Front amber/clear (`+6.94`), rear red (`-3.42`) |
| **Rear Tail Cluster (`ゴールドキング縦型`)** | L & R | `±(0.92 .. 1.12)` | `0.78 .. 1.48` | `-3.44 .. -3.40` | Vertical 3-tier combination housing: **Top Red** (brake/tail `Y = 1.24..1.46`), **Mid Amber** (turn `Y = 1.01..1.23`), **Bottom White** (reverse + reflector `Y = 0.78..1.00`) |
| **Rear High-Mount Brake / Marker** | L & R | `±(0.95 .. 1.08)` | `2.40 .. 2.48` | `-3.43 .. -3.40` | Upper rear corner auxiliary lamps flanking `SignRear` |

---

### 3.7 Destination Display Housings (`SignFront`, `SignRear`, `SignSideL`)

| Mesh Name | Location | X Span (m) | Y Span (m) | Z Span (m) | Display Face `(W × H)` (m) | Notes |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **`SignFront`** | Front header above windshield | `-0.880 .. +0.880` | `2.38 .. 2.74` | `+6.93 .. +6.97` | `1.76 × 0.36` | Flush glass header box; Kyoto City Bus route badge + destination |
| **`SignRear`** | Rear header / top of rear glass | `-0.700 .. +0.700` | `2.25 .. 2.58` | `-3.43 .. -3.40` | `1.40 × 0.33` | Rear route number + final destination |
| **`SignSideL`** | Left side, **between front & middle doors** | `+1.220 .. +1.245` | `1.98 .. 2.30` | `+3.65 .. +4.95` | `1.30 × 0.32` | Mounted in upper window band between `DoorFrameF` and `DoorFrameM` *(Note: current `bus.glb` places `SignSideL` over the front door at `Z = 5.90..7.10`, which should be moved rearward)* |

---

### 3.8 Driver Eye Position (`cockpitAnchor`)

| Parameter | Value in Game Coordinates (m) | Derivation |
| :--- | :--- | :--- |
| **`X` (lateral)** | **`-0.78 m`** | Driver seat centered ~`0.46 m` inboard from right outer wall (`-1.245 + 0.465 = -0.78 m`), aligned with steering column (`X ≈ -0.75 m`). |
| **`Y` (eye height above ground)** | **`2.00 m`** | Cab floor platform `Y ≈ 0.55 m` + seat base/suspension `~0.35 m` + seated driver torso-to-eye `~1.10 m` = `2.00 m` (with clear view through windshield `Y = 1.18..2.32 m`). |
| **`Z` (longitudinal from rear axle)** | **`+5.55 m`** | Front axle at `+4.80 m`; driver seat pedestal centered around `Z ≈ +5.25..+5.35 m`, forward-leaning seated eye at `Z ≈ +5.55 m`, ~`0.55 m` behind steering wheel (`+6.10 m`) and ~`1.40 m` behind windshield (`+6.95 m`). |
| **Current `busModel.js` `cockpitAnchor`** | `(-0.80, 2.05, +5.64)` | Within `0.02–0.09 m` of target; can be adjusted to `(-0.78, 2.00, +5.55)` when `bus.glb` FOH shifts from `+7.14` to `+6.95 m`. |

---

## 4. Key Deltas vs. Current Game Model (`CFG.bus` & `bus.glb`)

1. **Overall Length & Overhangs**: `CFG.bus.length` is currently `10.29 m` (`rearOverhang: 3.15 m`, FOH `2.34 m`) — `PDG-AA273KAN` is **10.490 m** (`rearOverhang ≈ 3.48 m`, FOH `2.21 m`).
2. **Height & Roof HVAC**: Current `bus.glb` roof reaches `3.00 m` and `RoofAC` reaches `3.14 m`; `PDG-AA273KAN` roof crown is **~2.86 m**, with total height **2.990 m** (Thermo King, Yokooji / Route 18) or **3.040 m** (Denso, Nishigamo).
3. **Front Door**: Current `bus.glb` has two split leaves (`DoorFrameF1/F2`); Kyoto `PDG-AA273KAN` uses a **single-leaf glide-slide door (`グライドスライドドア`)** that sits flush when closed and swings/slides forward beside the A-pillar.
4. **Curb-Side Safety Window & Bumper Blinkers**: Missing in `bus.glb`; Kyoto `PDG-AA273KAN` has a lower-left **safety window** (`Z = +6.68..+6.95`, `Y = 0.58..1.14`) and **bumper-corner turn signals** (`Y = 0.38..0.52`).
5. **Side Destination Sign (`SignSideL`)**: Currently over front door (`Z = +5.90..+7.10`); should sit **between front and middle doors** (`Z = +3.65..+4.95`).
6. **Right-Side Rear Emergency Exit & Post-Driver Window**: Missing in `bus.glb`; add the narrow fixed window behind the driver (`Z = +4.70..+5.18`) and rear emergency exit (`Z = -2.65..-1.75`).
7. **Non-Step Floor**: Current `bus.glb` `Floor` is flat at `Y = 0.45..0.55 m`; real `PDG-AA273KAN` has a **0.32–0.35 m** front/mid non-step floor stepping up to **0.72–0.85 m** at the rear.

---

## 5. Primary Verification Sources

- **Mitsubishi Fuso Aero Star-S (`PDG-AA273KAN`) Launch & Specs**: Mitsubishi Fuso May 21, 2007 release & MLIT heavy-vehicle fuel-economy filing (`10,490 × 2,490 × 2,985 mm`, WB `4,800 mm`, MD92TJ `220 kW / 1,324 N·m`, 5AT, `9,790 kg`, `79` pax).
- **Kyoto City Bus Fleet Registries (`1768–1779, 1783–1785`)**: FY2007 (Jan–Feb 2008) 15-unit `PDG-AA273KAN` deployment across Yokooji (`1771, 1772, 1777–1779`, Thermo King `2,990 mm`) and Nishigamo (`1768–1770, 1773–1776, 1783–1785`, Denso `3,040 mm`), 96MC B-I body, glide-slide front / wide sliding middle doors, reverse-T sashes, safety window, bumper turn signals, vertical Gold King tail clusters.
- **MLIT Standard Non-Step Bus Certification Guidelines (`標準仕様ノンステップバス認定要領`)**: Step/floor height (`≤270 mm` kneeling entry), `≤200 mm` interior step height, `≥800 mm` door/aisle width, emergency exit clearance.
- **Tire Dimension Standard**: Dunlop `275/70R22.5` (`959 mm` outer diameter / `479.5 mm` radius).
