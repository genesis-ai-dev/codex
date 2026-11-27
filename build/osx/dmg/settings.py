import os
import plistlib

app = defines["app"]
name = os.path.basename(app)
files = [app]
symlinks = {"Applications": "/Applications"}
background = defines["background"]
window_rect = ((120, 120), (620, 320))
icon_locations = {name: (155, 175), "Applications": (465, 175)}
icon_size = 104
default_view = "icon-view"
format = "ULFO"
filesystem = "APFS"

with open(os.path.join(app, "Contents", "Info.plist"), "rb") as info:
    icon_name = plistlib.load(info).get("CFBundleIconFile")
if icon_name:
    if not icon_name.endswith(".icns"):
        icon_name += ".icns"
    icon = os.path.join(app, "Contents", "Resources", icon_name)
