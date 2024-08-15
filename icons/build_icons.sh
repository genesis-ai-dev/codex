#!/usr/bin/env bash
# shellcheck disable=SC1091

set -e

# DEBUG
set -x  # Enable debug mode to print each command

echo "Script started"

QUALITY="stable"
COLOR="blue1"
CUSTOM_LOGO="./logo/codex-logo-2024.svg"

FORCE_REBUILD=false

while getopts ":if" opt; do
  case "$opt" in
  i)
    export QUALITY="insider"
    export COLOR="orange1"
    ;;
  f)
    FORCE_REBUILD=true
    ;;
  *) ;;
  esac
done

check_programs() { # {{{
  missing_programs=()
  for arg in "$@"; do
    if ! command -v "${arg}" &>/dev/null; then
      missing_programs+=("${arg}")
    fi
  done

  if [ ${#missing_programs[@]} -ne 0 ]; then
    echo "The following required programs are missing:"
    for program in "${missing_programs[@]}"; do
      echo "- ${program}"
    done
    echo "Please install the missing programs and try again."
    echo "You can usually install these with your package manager."
    echo "For example, on macOS with Homebrew:"
    echo "brew install imagemagick icoutils librsvg gnu-sed"
    exit 1
  fi
} # }}}

check_programs "composite" "magick" "png2icns" "icotool" "rsvg-convert" "gsed" "identify"

# . ./utils.sh

SRC_PREFIX=""
VSCODE_PREFIX=""

build_darwin_main() { # {{{
  if [[ ! -f "${SRC_PREFIX}src/${QUALITY}/resources/darwin/Codex.icns" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
    if [[ ! -f "icons/template_macos.png" ]]; then
      echo "Error: 'icons/template_macos.png' is missing."
      echo "Please ensure this file exists in the 'icons' directory."
      return 1
    fi

    echo "Checking input image size..."
    identify -format "Input image size: %wx%h\n" "${CUSTOM_LOGO}"

    rsvg-convert -w 1024 -h 1024 "${CUSTOM_LOGO}" -o "code_1024.png"
    if [[ ! -f "code_1024.png" ]]; then
      echo "Error: Failed to create 'code_1024.png'."
      echo "Please check if '${CUSTOM_LOGO}' exists and is accessible."
      return 1
    fi

    echo "Checking generated image sizes..."
    identify -format "code_1024.png size: %wx%h\n" "code_1024.png"

    magick composite "code_1024.png" -gravity center "icons/template_macos.png" "code_1024.png"
    magick "code_1024.png" -resize 256x256 code_256.png
    magick "code_1024.png" -resize 128x128 code_128.png
    magick "code_1024.png" -resize 32x32 code_32.png

    echo "Checking resized image sizes..."
    identify -format "%f size: %wx%h\n" code_256.png code_128.png code_32.png

    # Use png2icns for macOS icon creation
    png2icns "${SRC_PREFIX}src/${QUALITY}/resources/darwin/Codex.icns" code_256.png code_128.png code_32.png

    rm code_1024.png code_256.png code_128.png code_32.png
  fi
} # }}}

build_darwin_types() { # {{{
  rsvg-convert -w 128 -h 128 "${CUSTOM_LOGO}" -o "code_logo.png"

  for file in "${VSCODE_PREFIX}"vscode/resources/darwin/*; do
    if [[ -f "${file}" ]]; then
      name=$(basename "${file}" '.icns')

      if [[ "${name}" != 'Codex' ]] && [[ ! -f "${SRC_PREFIX}src/${QUALITY}/resources/darwin/${name}.icns" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
        # Use sips (pre-installed on macOS) or convert (from ImageMagick)
        if command -v sips &>/dev/null; then
          sips -s format png "${file}" --out "${name}_512x512x32.png"
        else
          magick "${file}" "${name}_512x512x32.png"
        fi

        magick composite -blend 100% -geometry +323+365 "icons/corner_512.png" "${name}_512x512x32.png" "${name}.png"
        magick composite -geometry +359+374 "code_logo.png" "${name}.png" "${name}.png"

        magick "${name}.png" -resize 256x256 "${name}_256.png"

        png2icns "${SRC_PREFIX}src/${QUALITY}/resources/darwin/${name}.icns" "${name}.png" "${name}_256.png"

        rm "${name}_512x512x32.png" "${name}.png" "${name}_256.png"
      fi
    fi
  done

  rm "code_logo.png"
} # }}}

build_linux_main() { # {{{
  if [[ ! -f "${SRC_PREFIX}src/${QUALITY}/resources/linux/code.png" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
    rsvg-convert -w 256 -h 256 "${CUSTOM_LOGO}" -o "${SRC_PREFIX}src/${QUALITY}/resources/linux/code.png"
    mkdir -p "${SRC_PREFIX}src/${QUALITY}/resources/linux/rpm"
    magick "${SRC_PREFIX}src/${QUALITY}/resources/linux/code.png" "${SRC_PREFIX}src/${QUALITY}/resources/linux/rpm/code.xpm"
  fi
} # }}}

build_media() { # {{{
  if [[ ! -f "${SRC_PREFIX}src/${QUALITY}/src/vs/workbench/browser/media/code-icon.svg" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
    cp "${CUSTOM_LOGO}" "${SRC_PREFIX}src/${QUALITY}/src/vs/workbench/browser/media/code-icon.svg"
    gsed -i 's|width="100" height="100"|width="1024" height="1024"|' "${SRC_PREFIX}src/${QUALITY}/src/vs/workbench/browser/media/code-icon.svg"
  fi
} # }}}

build_windows_main() { # {{{
  if [[ ! -f "${SRC_PREFIX}src/${QUALITY}/resources/win32/code.ico" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
    rsvg-convert -w 256 -h 256 "${CUSTOM_LOGO}" -o "code_256.png"
    magick "code_256.png" -define icon:auto-resize=256,128,64,48,32,16 "${SRC_PREFIX}src/${QUALITY}/resources/win32/code.ico"
    rm "code_256.png"
  fi
} # }}}

build_windows_type() {
  local FILE_PATH IMG_SIZE IMG_BG_COLOR LOGO_SIZE GRAVITY

  FILE_PATH="$1"
  IMG_SIZE="$2"
  IMG_BG_COLOR="$3"
  LOGO_SIZE="$4"
  GRAVITY="$5"

  if [[ ! -f "${FILE_PATH}" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
    if [[ "${FILE_PATH##*.}" == "png" ]]; then
      magick -size "${IMG_SIZE}" "${IMG_BG_COLOR}" PNG32:"${FILE_PATH}"
    else
      magick -size "${IMG_SIZE}" "${IMG_BG_COLOR}" "${FILE_PATH}"
    fi

    rsvg-convert -w "${LOGO_SIZE}" -h "${LOGO_SIZE}" "${CUSTOM_LOGO}" -o "code_logo.png"

    magick composite -gravity "${GRAVITY}" "code_logo.png" "${FILE_PATH}" "${FILE_PATH}"
  fi
}

build_windows_types() { # {{{
  mkdir -p "${SRC_PREFIX}src/${QUALITY}/resources/win32"

  rsvg-convert -b "#F5F6F7" -w 64 -h 64 "${CUSTOM_LOGO}" -o "code_logo.png"

  for file in "${VSCODE_PREFIX}"vscode/resources/win32/*.ico; do
    if [[ -f "${file}" ]]; then
      name=$(basename "${file}" '.ico')

      if [[ "${name}" != 'code' ]] && [[ ! -f "${SRC_PREFIX}src/${QUALITY}/resources/win32/${name}.ico" ]] || [[ "${FORCE_REBUILD}" = true ]]; then
        icotool -x -w 256 "${file}"

        magick composite -geometry +150+185 "code_logo.png" "${name}_9_256x256x32.png" "${name}.png"

        magick "${name}.png" -define icon:auto-resize=256,128,96,64,48,32,24,20,16 "${SRC_PREFIX}src/${QUALITY}/resources/win32/${name}.ico"

        rm "${name}_9_256x256x32.png" "${name}.png"
      fi
    fi
  done

  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/code_70x70.png" "70x70" "canvas:transparent" "45" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/code_150x150.png" "150x150" "canvas:transparent" "64" "+44+25"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-100.bmp" "164x314" "xc:white" "126" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-125.bmp" "192x386" "xc:white" "147" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-150.bmp" "246x459" "xc:white" "190" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-175.bmp" "273x556" "xc:white" "211" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-200.bmp" "328x604" "xc:white" "255" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-225.bmp" "355x700" "xc:white" "273" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-big-250.bmp" "410x797" "xc:white" "317" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-100.bmp" "55x55" "xc:white" "44" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-125.bmp" "64x68" "xc:white" "52" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-150.bmp" "83x80" "xc:white" "63" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-175.bmp" "92x97" "xc:white" "76" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-200.bmp" "110x106" "xc:white" "86" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-225.bmp" "119x123" "xc:white" "103" "center"
  build_windows_type "${SRC_PREFIX}src/${QUALITY}/resources/win32/inno-small-250.bmp" "138x140" "xc:white" "116" "center"
  build_windows_type "${SRC_PREFIX}build/windows/msi/resources/${QUALITY}/wix-banner.bmp" "493x58" "xc:white" "50" "+438+6"
  build_windows_type "${SRC_PREFIX}build/windows/msi/resources/${QUALITY}/wix-dialog.bmp" "493x312" "xc:white" "120" "+22+152"

  rm code_logo.png
} # }}}

if [[ "${0}" == "${BASH_SOURCE[0]}" ]]; then
  echo "Executing main functions"

  if ! build_darwin_main; then
    echo "Error occurred in build_darwin_main"
    exit 1
  fi

  if ! build_linux_main; then
    echo "Error occurred in build_linux_main"
    exit 1
  fi

  if ! build_windows_main; then
    echo "Error occurred in build_windows_main"
    exit 1
  fi

  if ! build_darwin_types; then
    echo "Error occurred in build_darwin_types"
    exit 1
  fi

  if ! build_windows_types; then
    echo "Error occurred in build_windows_types"
    exit 1
  fi

  if ! build_media; then
    echo "Error occurred in build_media"
    exit 1
  fi

  echo "All functions completed successfully"
fi

echo "Script finished"
