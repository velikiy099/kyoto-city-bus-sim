# Kyoto City Bus PDG-AA273KAN (Nishinippon Shatai Kogyo 96MC B-I) — Visual Reference

This document provides exterior, livery, sculptural, and interior/cockpit visual reference details for modeling the **Kyoto City Bus (京都市バス / 京都市交通局) PDG-AA273KAN** — Mitsubishi Fuso **Aero Star-S** (OEM of Nissan Diesel / UD Trucks **Space Runner RA**, `PDG-RA273KAN`) bodied with **Nishinippon Shatai Kogyo (西工) 96MC B-I** (10.5 m short wheelbase K-chassis, non-step, ZF 5-speed AT), introduced in FY2007 (January–February 2008, fleet numbers e.g. `1768`–`1779`, `1781`–`1784`).

---

## 1. Kyoto City Bus Livery & Markings

### 1.1 Standard Route Livery Color Palette (`一般路線色`)

Kyoto City Bus standard livery derives from historic Kyoto Municipal Tram (`京都市電`) colors. Rather than standard commercial paint codes, the Transportation Bureau specifies custom Munsell-referenced colors:

| Surface / Role | Japanese Name | Munsell Reference | Approximate sRGB | Approx. Hex | Notes / Modeling Guidance |
|---|---|---|---|---|---|
| **Base Body (Light Sage / Pale Mint)** | 淡緑色 (地色) | `7.5GY 8/2` | `190, 205, 177` | `#BECDB1` | Soft desaturated pale sage/cream-green; appears near cream-ivory in bright sun and pale mint in shade. |
| **Accent Bands & Skirt (Dark Forest Green)** | 濃緑色 (帯色) | `5G 3.5/2` | `69, 88, 78` | `#45584E` | Deep muted forest/slate green (`5G 2/2`–`5G 3.5/2` range depending on weathering/era). |
| **Window Surrounds / Pillars / Sash** | 窓枠・ピラー (黒) | — | `26, 29, 31` | `#1A1D1F` | Blacked-out (`ブラックアウト`) window frames, B/C/H-pillars, door frames, and recessed headlamp bezels. |
| **Roof Top Panel** | 屋根上面 | — | `216, 220, 214` | `#D8DCD6` | Light grey / off-white / pale neutral finish on top roof deck, distinct from side cantrail trim. |
| **Bumpers (Front & Rear)** | バンパー | — | `#BECDB1` / `#45584E` | — | Body-colored (`#BECDB1`) or dark green/black lower trim depending on lower skirt masking; rubber bumper corners dark charcoal (`#242628`). |

> **Design Note:** The dual dark-green bands on Kyoto City Bus vehicles traditionally symbolize the **Kamo River (鴨川)** and **Takase River (高瀬川)** flowing through Kyoto.

### 1.2 Stripe Layout & Transitions Across Faces

*(Based on the standard Kyoto City Bus livery applied to 96MC non-step buses; vertical heights are relative to a ~3.0 m body height)*

- **Left (Curb / Door) Side (+X):**
  - **Upper cantrail / sign header:** Dark forest green (`#45584E`) or blacked-out upper window header strip along the roofline edge above the destination sign and side windows, transitioning into light grey/off-white on the roof deck.
  - **Window band:** Continuous blacked-out (`#1A1D1F`) glass-and-pillar band spanning from the front door/safety window rearward to the rear corner pillar.
  - **Waist & lower skirt:** Light sage green (`#BECDB1`) main waist panel below the windows, accented by **two parallel dark forest green (`#45584E`) bands/stripes** (an upper belt-line stripe below the window sill and a lower skirt/hem band along the bottom edge, stepping cleanly across the front glide-slide door lower panel, wheel arch flares, and middle sliding door lower panel).
- **Right (Driver) Side (-X):**
  - Mirrors the left side's horizontal alignment: blacked-out window band (`#1A1D1F`) above the belt rail, light sage (`#BECDB1`) waist panel, and parallel dark green (`#45584E`) waist/lower-skirt bands uninterrupted by passenger doors, following cleanly over the front and rear wheel-arch cutouts.
- **Front Mask (+Z):**
  - Upper header above windshield (housing `SignFront` destination box) framed cleanly in light sage / dark green trim with a blacked-out windshield surround (`#1A1D1F`) extending downward beneath the windshield glass to form the dark lower bezel.
  - Below the windshield bezel, the front panel is light sage (`#BECDB1`) with the dark green (`#45584E`) accent band/lower apron tying into the side belt/skirt lines, wrapping smoothly around the rounded 96MC front corners.
- **Rear Face (-Z):**
  - Upper rear window and `SignRear` housing framed in black (`#1A1D1F`) / dark green (`#45584E`); lower engine-access panel in light sage (`#BECDB1`) with the two dark green (`#45584E`) bands continuing around from both side panels across the rear corners and lower bumper/apron.

### 1.3 Markings, Crest, Fleet Numbers & Decals

| Marking / Decal | Appearance | Placement |
|---|---|---|
| **Kyoto City Crest (`京都市章` / 丸に京)** | Stylized circular crest combining the sun disk and the character 「京」 in metallic/gold or crisp light trim. | **Front (+Z):** Centered prominently on the front nose panel below the windshield bezel and above the front bumper.<br>**Sides:** Often paired with `京都市バス` / bureau markings on the lower side panel. |
| **Operator Lettering (`京都市バス`)** | Clean dark green or white/gold Japanese gothic lettering (`京都市バス`). | **Left & Right Sides:** Waist panel below the windows (typically rearward of the front door on the left side, and forward/mid waist on the right side).<br>**Rear:** Below rear window / engine lid area. |
| **Fleet Number (`社番`, 4-digit e.g. `1768`, `1771`, `1775`, `1784`)** | 4-digit dark or white block numerals applied via paint/decal. | **Front:** Upper-left or lower corner of windshield / below destination sign.<br>**Left/Right Sides:** Waist panel just behind the front door (left) and below driver window / rear panel (right).<br>**Rear:** Upper right/left corner of rear glass or engine panel. |
| **Commercial License Plate (`緑ナンバー`)** | Green plate with white characters (`京都 200` / `か 17-71`, `か 17-68`, `か 17-75`, `か 17-84`, etc.). | **Front (+Z):** Recessed center-low (or slightly offset) on the front bumper.<br>**Rear (-Z):** Recessed plate pocket on the rear engine panel/bumper with an overhead plate lamp. |
| **MLIT Standard Non-Step Decal (`標準仕様ノンステップバス`)** | **Green sticker** (2006–2014 FY standard, marked `05` in the wheel graphic; distinct from earlier 2004–2005 blue and 2015+ pink stickers), featuring a bus silhouette + `"ノンステップバス"` text. | **Front:** Lower front panel / windshield corner.<br>**Left Side:** Near front/middle doors on body or glass.<br>**Rear:** Lower rear panel. |
| **Wheelchair Accessibility Decal (`車椅子マーク`)** | Standard blue-and-white International Symbol of Access square decal. | **Front:** Beside `SignFront` destination box.<br>**Left Side:** Beside middle entrance door.<br>**Interior:** Wheelchair bay wall panel. |
| **Boarding / Alighting Decals (`後乗り・前降り` / `入口` / `出口`)** | High-contrast Japanese (+ English/pictogram) decals indicating Kyoto City Bus's rear/mid-boarding, front-alighting fare system. | **Middle Door (Left Side):** `"入口"` (Entrance) on door glass / pocket window.<br>**Front Door (Left Side):** `"出口"` (Exit) on door glass or body pillar beside front door.<br>**Multi-zone cars (`整理券車`, e.g. `1771` originally):** `"整理券車"` plate/sticker near middle entrance and front windshield. |
| **Depot-Specific Detail** | Drive-recorder warning sticker (`ドライブレコーダー搭載車両`). | On direct-operated Nishigamo cars (`1768`, `1769`), applied directly to the exterior front body rather than inside the glass. |

---

## 2. Exterior Sculptural Details (96MC B-I on PDG-AA273KAN)

> **OEM / Chassis Context:** `PDG-AA273KAN` (Mitsubishi Fuso **Aero Star-S**) is an OEM rebadge of the Nissan Diesel **Space Runner RA** (`PDG-RA273KAN`). Externally it shares the exact **Nishinippon Shatai Kogyo 96MC B-I** body shell, UD MD92TJ engine cooling louvers, and lighting layout—differing visually from Fuso's native Aero Star (`MP35`/`MP37`) and distinguished from the UD Space Runner RA primarily by the Fuso emblem/steering hub and fleet numbering.

### 2.1 Front Mask Contours, Windshield & Safety Window

- **Overall Profile:** Clean, upright-yet-aerodynamic 96MC B-I front mask with smoothly radiused vertical corner pillars wrapping into the body sides.
- **Windshield & Lower Bezel:** Large, slightly raked panoramic two-piece or wide curved single-pane front windshield with a prominent **blacked-out lower bezel (`ブラックアウト`)** dipping slightly along the bottom edge.
- **Curb-Side Safety Window (`セーフティウインドウ` / 視野拡大窓):**
  - A hallmark Kyoto City Bus specification on the 96MC **B-I** body. Mounted low on the front-left (+X) corner just ahead of the front door and below the main windshield line to give the driver direct sightlines to pedestrians/cyclists in the curb-side blind spot.
  - Because Kyoto City Bus places the safety window in the space where standard 96MC masks often place upper corner lamps/turn signals, the **front turn signals (`ウインカー`) are relocated lower down into/onto the bumper area**, giving Kyoto 96MC buses a distinct front "face."
- **Wipers:** Dual pantograph/radial front wipers mounted near the lower windshield bezel, resting symmetrically angled outward/downward at the bottom of the glass.
- **Headlamp Housings & Lamps:**
  - **Quad rectangular headlamps (`角形4灯式`)**: Two rectangular/square lamps per side (low beam + high beam) recessed inside black molded horizontal bezels flush with the lower front panel above the bumper.
- **Front Bumper & Fog Lamps:**
  - Segmented/wraparound heavy-duty front bumper with dark rubber corner end-caps, central lower air intake/step recess, central license plate recess, and **recessed rectangular fog lamps** (plus relocated turn-signal/position lamps in the bumper/lower apron).
- **Front Grille / Crest:**
  - Smooth front nose panel between the headlamps (UD-spec vent/access seam lines) carrying the central **Kyoto City Crest (`京都市章`)** and Fuso Aero Star-S badging where fitted.

### 2.2 Side Mirrors

- **Right (Driver) Side (-X):** Long, forward-cantilevered tubular/aerodynamic mirror arm extending forward-outward from the upper A-pillar, holding a tall vertical rectangular main mirror plus a smaller convex lower/wide-angle auxiliary mirror (`サイドアンダーミラー`).
- **Left (Curb) Side (+X):** Forward-swept tubular bracket mounted at the upper left A-pillar/roof corner carrying **dual stacked/angled mirrors** (tall flat main mirror + convex wide-angle mirror) plus an **under-mirror (`アンダーミラー`)** angled downward to cover the area directly in front of the front bumper and curb-side front corner.

### 2.3 Side Windows & Emergency Exit

- **Blacked-Out Sashes & Pillars:** Flush/semi-flush tinted heat-absorbing side glass with black aluminum sashes and dark pillars.
- **Reverse-T Windows (`逆T字窓`):** Large fixed lower glass pane (~60–65% height) topped by a horizontal transom bar and a pair of horizontal sliding upper sashes (~35–40% height) for ventilation.
- **2007 PDG-AA273KAN Driver-Side Signature Detail:**
  - Immediately behind the driver's window (`-X` side), the main reverse-T bay is slightly shortened and followed by a **narrow vertical fixed window (`固定小窓`)** created by shifting the H-pillar rearward so passengers can easily reach and slide the adjacent window sash.
- **Rear Right/Left Corner & Emergency Door (`非常口`):**
  - Standard MLIT-mandated rear emergency exit door positioned toward the rear of the **right (driver, `-X`) side** (standard on Japanese right-hand-drive buses, opposite the curb-side passenger doors), featuring an upper window pane, exterior recessed pull handle behind a protective cover, red/green emergency exit placard (`非常口`), and audible door-open alarm switch. *(Note: some generic summaries misstate the side; on Japanese RHD buses the emergency exit is on the offside/driver side `-X` near the rear.)*

### 2.4 Doors (Front & Middle)

- **Front Door (+X, Forward of Front Axle):**
  - **Glide-slide door (`グライドスライドドア`)** — Kyoto City Bus's signature non-step front door choice on 96MC buses (outward parallel-swinging/sliding two-leaf or single wide glide mechanism providing clear unobstructed step-free width without folding leaves intruding into the vestibule).
  - Tall full-height or near-full-height glazed door leaves (two-pane upper/lower glass separated by a mid-rail or deep lower glass panel for curb visibility), heavy black rubber center meeting gaskets, and dark lower kick plates.
- **Middle Door (+X, Mid-Wheelbase):**
  - **2-leaf external/pocket sliding door (`引戸`)** opening outward/rearward along the body side (with a recessed pocket window behind the opening), wide clear vestibule for wheelchair ramp deployment, tall vertical glass panes (~70% door height), black rubber perimeter seals, and dark scuff/kick panels at the bottom.

### 2.5 Rear Face (-Z)

- **Rear Window & Destination Housing:**
  - Wide, rounded-corner single-pane rear window centered in the upper rear face, with `SignRear` (originally a backlit film roll `方向幕` behind glass; later retrofitted on many units like `1771` and `1784` with OJI or LECIP full-color LED matrices) integrated neatly above/inside the upper rear window header, flanked by Kyoto's **last-bus indicator lamps (`終車灯`: green = second-to-last bus `終前`, red = final bus `最終`)**.
- **Engine Access Lid & Cooling Louvers (`通風孔`):**
  - Large bottom-hinged rear engine-bay access lid with crisp perimeter panel seams, recessed latches, and **NC-punched perforated metal louver grilles** on the rear/rear-side panels tailored to the **UD MD92TJ** radiator and intake layout (visually matching Space Runner RA rather than native Fuso Aero Star).
- **Tail Lamp Clusters:**
  - **Low-mounted vertical stacked round tail lamps (`汎用丸形テール` / Goldking-Koito style)** recessed into vertical pressed housings on the lower left and right corners to satisfy 2005/2006 lighting height regulations (distinguishing this late 96MC batch from the earlier "Civilian-tail" `シビリアンテール` units). Each vertical stack integrates brake/tail, amber turn signal, and reverse/reflector modules.
- **Rear Bumper & Plate Recess:**
  - Wraparound rear bumper matching the front bumper contour, with recessed rear license plate pocket and plate illumination lamp at center-left/center.

### 2.6 Roof Equipment

Kyoto City Bus FY2007 `PDG-AA273KAN` units split into **two distinct roof HVAC condenser styles** depending on original depot assignment:
1. **Denso (`デンソー`) Low-Profile Pod** — e.g., **Nishigamo Depot (`西賀茂`)** units (`1768`, `1769`, `1775`, `1784`):
   - Flat, boxy, low-profile rectangular white/light-grey condenser shroud centered mid-roof with slatted side/top intake grilles and chamfered edges.
2. **Thermo King (`サーモキング`) Domed Pod** — e.g., **Yokooji Depot (`横大路` / Hankyu-operated)** units (`1771`):
   - Distinct rounded, central-humped ("mushroom-like" / contoured dome) white/light-grey condenser housing on the roof, noticeably taller/rounder in silhouette than the flat Denso unit.
- **Other Roof Fixtures:** Front and rear low-profile roof ventilation hatches (`ベンチレーター`), whip radio/GPS antenna near the front roof edge, and amber/red upper clearance marker lamps at the upper corners.

---

## 3. Interior & Driver Cockpit Details

### 3.1 Floor Layout

- **Non-Step Low-Floor Zone (Front Door to Behind Middle Door):**
  - Completely step-free flat aisle covered in **dark grey speckled non-slip vinyl flooring (`ロンリウム`)**, with high-visibility yellow/orange tactile edge strips along door thresholds.
  - Raised front left/right **wheelhouse boxes** behind the front door and driver station.
  - **Wheelchair / Stroller Bay:** Located in the low-floor section opposite/forward of the middle door, equipped with folding seats and wall-mounted wheelchair restraint belts + blue wheelchair pictogram.
- **Rear High-Floor Zone (Behind Middle Door):**
  - Two-step riser (or sloped ramp + steps) immediately aft of the middle door leading up to the elevated rear floor over the rear axle and engine bay.

### 3.2 Seating Arrangement & Moquette

- **Urban-Type (`都市型`) Wide-Aisle Layout:**
  - **Front–Mid Low-Floor Area:** Minimized seat count to maximize standing capacity and aisle width—typically 1-seat forward-facing rows and/or longitudinal folding bench/priority seats over the front wheelhouses and wheelchair bay.
  - **Rear High-Floor Area:** Forward-facing 1-seat + 2-seat rows flanking the central aisle, culminating in a **5-across rear bench** against the rear bulkhead.
- **Seat Moquette (`モケット`):**
  - Conforms to the **MLIT 2005+ Standard Non-Step Bus specification**:
    - **General Seats:** Medium-to-navy **blue patterned moquette** (replacing Kyoto City Bus's pre-2005 traditional solid wine-red / Gosho-guruma moquette).
    - **Priority Seats (`優先座席`):** Distinct **orange or warm brown-red moquette** (with priority seat pictograms on adjacent glass/walls) near the front/mid low-floor section.
  - **Seat Backs & Grab Handles:** Molded grey/charcoal plastic seat-back shells topped by **curved silver/stainless or yellow-orange grab handles** across the top edge of each seat back.

### 3.3 Stanchions, Straps, Lighting & Displays

- **Stanchion Poles (`手すり`):** Vertical floor-to-ceiling and curved aisle-side stainless-steel poles wrapped with **high-visibility orange/yellow textured resin/rubber sleeves** (MLIT barrier-free standard) at doorways, wheelhouses, and along seat rows.
- **Overhead Grab Straps (`つり革`):** Round and triangular handgrips suspended from overhead longitudinal stainless handrails along both sides of the aisle via light grey/ivory straps.
- **Stop Buttons (`降車ボタン`):** Round or rectangular illuminated orange/red push-buttons (`とまります` backlit indicator) mounted on vertical stanchions and side window mullions at seated and standing heights, accompanied by chime/bell notification.
- **Wall & Ceiling Panels:** Smooth light grey / off-white laminated interior side panels and ceiling panels; characteristic **96MC moquette-trimmed divider panel** between the longitudinal/mid area and rear stepped seating.
- **Interior Lighting:** Continuous twin rows of **Goldking (`ゴールドキング`) flush/diffused fluorescent ceiling light strips** running along the upper cantrails/ceiling coves.
- **Overhead Next-Stop Display & Fare Chart:** Suspended above the front windshield header (visible to passengers), housing a multi-line digital LED/LCD next-stop display & route fare matrix (e.g., LECIP or OJI), flanked by route/fare-zone placards (`均一区間` / `整理券` instructions).

### 3.4 Driver Cockpit (`-X` Right Side)

Because `PDG-AA273KAN` is an OEM UD Space Runner RA, the cockpit ergonomics and dash architecture are **UD Trucks / Nissan Diesel** design:

- **Driver Seat & Partition:**
  - Air-suspended dark grey/black cloth driver seat with headrest and right/left armrests.
  - Behind-driver partition panel (waist-height opaque grey/moquette-faced panel topped by a **tall clear acrylic/polycarbonate safety shield** with a dark frame separating the driver from the passenger compartment behind).
- **Steering Column & Wheel:**
  - Angled tilt/telescopic steering column with column-mounted turn-signal/wiper/retarder stalks.
  - Large-diameter **3-spoke / 4-spoke UD-spec steering wheel** with a central horn pad carrying the **Mitsubishi Three-Diamond emblem** (the primary cockpit visual giveaway separating `PDG-AA273KAN` from `PDG-RA273KAN`'s UD badge).
- **Instrument Binnacle & Gauges:**
  - Semi-circular/hooded UD instrument cluster positioned directly behind the wheel featuring large **analog speedometer** and **tachometer**, flanked by **dual air-pressure gauges** (front/rear brake circuits), coolant temperature gauge, fuel gauge, and a row of color-coded warning/tell-tale lamps (door open, ABS, kneeling, parking brake, stop request `"とまります"`).
- **Side Switch Console & AT Selector:**
  - Wraparound right-hand (`-X`) and center-left switch consoles with large tactile **door control switches** (front glide-slide, middle sliding), **ZF ECOMAT 5-speed automatic transmission push-button selector** (`D / N / R` + range buttons), kneeling/air-suspension switches, HVAC/defroster dials, hazard switch, and destination-sign / voice-announcement (`音声合成`) controller (LECIP/Resonant).
- **Farebox (`運賃箱`) — Immediately Left of Driver (+X side, beside Front Exit):**
  - Tall upright **Lecipt / Odawara-style bus farebox** mounted on the floor beside the front exit aisle, featuring a clear acrylic coin chute/hopper, bill acceptor, IC card (`PiTaPa` / `ICOCA`) touch reader on top, and driver-facing display/keypad. *(Historically delivered with change-maker `両替方式` units in 2008; later fleetwide upgraded to automatic-change `つり銭方式` units.)*
- **Sunvisor & Interior Mirrors:**
  - Adjustable dark-tinted pull-down driver sunvisor above the windshield, plus a wide rectangular **interior rearview mirror** above the center windshield (and secondary convex passenger-monitoring mirror angled toward the middle door).

---

## 4. Reference Sources

- Kyoto City Bus `PDG-AA273KAN` (1768–1784) fleet & depot profiles (Nishigamo Denso vs. Yokooji Thermo King, LED/film signs):
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFFgQ34N6uYGamlhLky6TtpBL05sXDtxh85J5l6__rVuGVdKEKOEWQS5sofQYkNRbdIYCkloFAtvaeyETtSL_587BFfoYgB9fhksB4kN7n7oYZfiQsArebI79VzLKZwpLPJntM4EA==>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFIgeQqqwvhTretskT_Q51IxG46NIOkK7I28gI98E6oB6l3yE0OSPxnpn3Ya7v4i9hY-8j-XXd82Ifv7Rmp00_Bc8GLkGX_uzd-skmtDksltLG2rK1cuomm7dxKyQGf6pWhK7dFrC2Y>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEQ06IcWtuXxhm-HX1Cjd0MvSGPy_fL_R8wl1KkAnbhWUbt-h9oBVqvJK4k3TwfAlx8XEhg1t3SESDVpRUSsNNd9IENQ5OlmB_lpanyUEIRbpud_FpzfwVy89YRi22rEodAdoDFJGm0B6FR>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF8xnRx9AZEMib_UvcSCY59nX4D9gkZzOGksU8EhYheJ5Dzzcnc8K0EGj1lX7ZoC42Oi8NoaWlahYa8GRPNDyQ3UgaGobH0WIqCgEQz6ZLPVFSBQ59hQi_cDhp9GS4ViU9Zu3cDUbwI5Nogk0PcjVv7VPIdMWt_pF8=>
- Kyoto City Bus Munsell color standards (`7.5GY 8/2` & `5G 3.5/2`) and livery notes:
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHZ8Uz-8xayEfEH6CWInIeBdk9rf-Zt8PFJrr8h0NrghIHsnfsCnSszbUD-CZcsrZff3qqyCz-HN7VoxM3OCRY6ijJ9tQcuXcVXA2OVtV8liWD0aa5HI8IB9GD28APWXrc=>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHW7IYGjoELgVgcwWaqgMTd2vDB8sSgCmlucE6VBWUG2Y8W_TF2UptNO5S7XXQhLrj8k2zrAloq7_NaqXxXuyTdgJgvvZ0aSAJtwbW_FuILmwiIG3a40uukXY7rAwXXqw==>
- 96MC B-I front mask, safety window, glide-slide door, reverse-T + driver-rear fixed window, rear tail lamps & Thermo King / Denso HVAC details:
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGvz_SKs9ProGoJcQ2BAkz4v8vLRxaIT36uTKcMhQ1Cecsndu6mNfLTptdlE1LJtGHbHSL5DREoZB99aYLFUIl_4x0XnVISJ9qr5oLAs-JJ_kOyPo3Inyrfh9vdDyNsv1JNNGPq7J45KWvZnDAj4rUQ6Ohw-fmh>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEWO5eOU9hJlROXWXoVt59NL5dn_GcAbNDW3RFMFcXdry4TPfNLxUFoqE_V4QaulOu-x81JRqTnxBl4Q4V0-z_QJFUfxmoUSpLcScm9bnqlDtdU6evQkCKMc55rfp7cL3rmTQ==>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHMdEgvyamPVZAwOUsKHh3nQOCUY0ckbBHKV3yPPUEijl-fvwrWod5Tf011WkUslKHJNj4FpW0HKHUAJyzetrK-rilpt8Pu_0MTh9oK2JJP32UTEEl6v8hP050tU-LqxKR_JQ==>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH37_vmUD1AhtPNvMaDVeszQHMFVoHPo8vEItC1fUwpIxaq-BjfBSFPn1UIuS-51xUNhkagHEtzLTv-8HCnO9VRAYdfzFipc4Hz55eGR0MPL_jAxCm9T_CZtDHE4mRlej1160CRzzM=>
- Interior moquette, stanchions, stop buttons, MLIT `05` green non-step decal, farebox & UD cockpit details:
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFHkM-uWLgBrEe8PBMRllJUY_JL4Zed61knDyyHXZXstmEDDmYoWtrxligju2tCySudNaU9A2ur-1eHLC2Bbkxse0Y8LzRlvl6zsnXu9dSdV8pVzh4_tlecfOjzzzrkEMiaIe5GkSo0XijZFow=>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG5ejVoLA0TA_ZzJhz-IdggadhLMRx5pLcLFHNp-dwG_vx7_4ln2H7495cTILtUkI09nEmyDXyK3LRxoJSQteLtXQdBqA48pUH6ddQOKqf0KU9oa4lnD7sNGT2aoMlYU_Bc7A==>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEXkFsmylSW2l4XGlijRis6kRUl4BOXpb9f9Dhx72g9Ow3oO32L3altwC-9_ee9zC_PxmauoNirM9hj5ezub7i6d78MUY13eLK7liS6Mm_67Z3STncmrhQlRPvWbooXo8VRBNLTTZxkOmdU5_if>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQECi7WV-Z3oXfmE1lDF0Z9j7xSAv1nYUYNZTGO8f9WMlph_4kFkCNGAcTxGMjJxg1w0YKEODconV41J8NyAMcNE8v1q6TSJnzQmNgSm6_kHk_QqaSruC2NSWLyBHq10YQkFu8-pb6J87VvXm0NwVPAqTK1Hkf18nCYHU20=>
  - <https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH392J0nppWVTbK602XGRW6-7KUy9hc5SP6wahmQ32IlPS3TEBoe5noPyYC7dU7BauOv3KCCWh6mY0HWwuGnlwAvT_LuERbg87S0QophnQl-iSfW3ecUc9U>
