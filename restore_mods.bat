@echo off
setlocal

if exist "mods" (
    rmdir /s /q "mods"
)

if exist "mods_origin" (
    ren "mods_origin" "mods"
)

exit
