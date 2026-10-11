#!/bin/zsh
# Re-runnable rewrite of Architect's Java to lab-ui (run from the repo root; idempotent). Leaves api/SiteEvents.java's own
# nested Guard alone, and the classes being deleted.
set -e
files=($(grep -rlE 'dev\.larattalabs\.architect\.(client\.ui\.(Kit|Panels|UiStyle|TextUtil|GuardedHud)|client\.hud\.UiBits|ui\.Guard)\b|\b(Guard\.(run|call)|GuardedHud\.of)\("' mod/src/main mod/src/client apitest --include='*.java' \
  | grep -vE '/api/SiteEvents\.java$|/client/ui/(Kit|Panels|UiStyle|TextUtil|GuardedHud)\.java$|/client/hud/UiBits\.java$|/architect/ui/Guard\.java$' || true))
for f in $files; do
  perl -pi -e '
    s/dev\.larattalabs\.architect\.client\.ui\.(Kit|Panels|UiStyle|TextUtil|GuardedHud)\b/dev.larattalabs.labui.client.ui.$1/g;
    s/dev\.larattalabs\.architect\.client\.hud\.UiBits\b/dev.larattalabs.labui.client.hud.UiBits/g;
    s/dev\.larattalabs\.architect\.ui\.Guard\b/dev.larattalabs.labui.ui.Guard/g;
    s/\b(Guard\.(?:run|call)|GuardedHud\.of)\("(?!architect_mc:)([^"]+)"/$1("architect_mc:$2"/g;
  ' $f
done
# same-package users that had no import line: client/hud/Toasts.java uses UiBits (and Kit/Panels/UiStyle/TextUtil via imports)
for f in mod/src/client/java/dev/larattalabs/architect/client/hud/*.java; do
  [[ $f == */UiBits.java ]] && continue
  if grep -qE '\bUiBits\.' $f && ! grep -q 'import dev.larattalabs.labui.client.hud.UiBits;' $f; then
    perl -0pi -e 's/(\nimport )/\nimport dev.larattalabs.labui.client.hud.UiBits;$1/' $f
  fi
done
