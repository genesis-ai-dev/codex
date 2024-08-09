import os
from PIL import Image
import cairosvg

def convert_svg_to_png(svg_path, png_path):
    cairosvg.svg2png(url=svg_path, write_to=png_path)

def overlay_logo_on_bmp(bmp_path, logo_png_path, output_path, position):
    # Open the BMP file
    bmp_image = Image.open(bmp_path)

    # Open the PNG logo
    logo_image = Image.open(logo_png_path).convert("RGBA")

    # Resize the logo if necessary (optional)
    # logo_image = logo_image.resize((new_width, new_height), Image.ANTIALIAS)

    # Create a new image with an alpha layer (RGBA)
    bmp_image = bmp_image.convert("RGBA")

    # Paste the logo onto the BMP image at the specified position
    bmp_image.paste(logo_image, position, logo_image)

    # Save the new BMP file
    bmp_image.save(output_path, format="BMP")

# Update paths to use relative paths from the project root
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
svg_logo_path = os.path.join(project_root, "logo", "codex-logo-2024.svg")
temp_png_logo_path = os.path.join(project_root, "patches", "user", "temp_logo.png")
bmp_paths = [
    os.path.join(project_root, "build", "windows", "msi", "resources", "insider", "wix-dialog.bmp"),
    os.path.join(project_root, "build", "windows", "msi", "resources", "insider", "wix-banner.bmp")
]
output_paths = [
    os.path.join(project_root, "build", "windows", "msi", "resources", "insider", "wix-dialog-new.bmp"),
    os.path.join(project_root, "build", "windows", "msi", "resources", "insider", "wix-banner-new.bmp")
]

# Add error handling and file existence checks
if not os.path.exists(svg_logo_path):
    raise FileNotFoundError(f"SVG logo file not found: {svg_logo_path}")

for bmp_path in bmp_paths:
    if not os.path.exists(bmp_path):
        raise FileNotFoundError(f"BMP file not found: {bmp_path}")

# Convert the SVG logo to PNG
convert_svg_to_png(svg_logo_path, temp_png_logo_path)

# Define the positions where the logo should be placed
positions = [(50, 50), (50, 50)]  # Adjust these positions as needed

# Overlay the logo on each BMP file
for bmp_path, output_path, position in zip(bmp_paths, output_paths, positions):
    overlay_logo_on_bmp(bmp_path, temp_png_logo_path, output_path, position)

# Clean up the temporary PNG file
os.remove(temp_png_logo_path)

print("Logo replacement completed successfully.")
