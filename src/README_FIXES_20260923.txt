HERTZINNO Realtime Monitoring - Alarm Configuration changes
Baseline: src(20260923-033527).zip
Date: 2026-09-23

Implemented
===========
1. Alarm strategy enable/disable
   - Alarm Configuration owns the enabled strategy state.
   - Reads GET /alarm_strategy_enable.
   - Enable/Disable uses the existing write/read-back service flow.
   - Camera Control remains responsible only for runtime camera/detection controls.

2. Alarm regions: camera-first read + draft editing
   - Opening/reloading Alarm Configuration reads GET /system/scan_area from the camera.
   - Supports drawing, selecting, deleting the selected region, clearing selection,
     clearing all regions, and saving.
   - Delete/Clear only changes the draft; the camera changes only after Save.
   - Save writes PUT /system/scan_area and uses device read-back as authority.

3. Stable alarm-region ID / number / name
   - Removed the old localStorage + array-index-only naming model.
   - Schema v19 adds camera_alarm_regions in SQLite.
   - Each region has stable id + current display order (#1, #2...) + operator name + geometry.
   - Names remain associated with geometry/stable id if a middle region is deleted/reordered.
   - The video overlay displays "#N - Name" for every region.

4. Unified Alarm Configuration page
   - Alarm Strategy, Alarm Conditions, and Alarm Regions are on one page.
   - Strategy enable/disable is in this same page.

5. PRPD copy removed
   - The PRPD chart stays mounted even when its rolling data window is empty.
   - Removed the waiting/explanatory text from both the active acoustic panel and the
     legacy realtime acoustic-camera template.

Additional bug fixed
====================
The previous region drag function returned normalized values 0..1, while CSS/table/device
conversion treated the same values as percentages 0..100. Drawn regions could therefore be
roughly 100x too small / written to the wrong coordinates. Region drawing now consistently uses
0..100 percentages and converts to 1920x1080 only when writing scan_area.

Important protocol limitation
=============================
The current /detect_logs payload does not expose an alarm-region id/index. /energyData contains
pixelX/pixelY, but the protocol does not define its coordinate system well enough to assert that
it is identical to /system/scan_area. Therefore this change deliberately does NOT guess which
region triggered an historical alarm. It establishes durable region metadata so the event/alarm
record chain can attach the correct region name once either:
  A) firmware returns a region/area index in the alarm record, or
  B) the pixel coordinate relationship is verified on a real camera.

Validation performed
====================
- TypeScript syntax transpile check passed for all 18 modified TS/Vue script files.
- SQLite v19 table SQL parser/CRUD smoke check passed.
- New alarm-region i18n keys exist in en/zh-CN/zh-TW/es/ru/tr.
- Old region-name localStorage code is no longer referenced.
- PRPD waiting/unavailable copy is no longer referenced by realtime components.

Note
====
The uploaded archive contains src only (no package.json/node_modules), so a full Electron/Vue
production build could not be executed in this environment. Run the normal project typecheck/build
once these files are placed back into the complete project.
