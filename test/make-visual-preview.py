from pathlib import Path
import json
import os

plugin = Path(__file__).resolve().parent.parent
artifacts = Path(os.environ.get('DSH_TEST_ARTIFACTS') or (plugin.parent / (plugin.name + '-local-records') / 'artifacts')).resolve()
try:
    artifacts.relative_to(plugin)
except ValueError:
    pass
else:
    raise ValueError('DSH_TEST_ARTIFACTS must be outside the plugin source directory.')

from PIL import Image, ImageDraw, ImageFont

directory = Path(json.loads((artifacts / 'current-visual-preview.json').read_text(encoding='utf-8'))['directory'])
font_path = 'C:/Windows/Fonts/msyh.ttc'
font = ImageFont.truetype(font_path, 24)
small = ImageFont.truetype(font_path, 15)
background = Image.new('RGBA', (960, 540), '#141923')
draw = ImageDraw.Draw(background)
draw.rounded_rectangle((156, 146, 804, 434), 18, fill='#1c2330', outline='#2a3546', width=1)
draw.text((198, 184), '桌面操作 · 本地渲染预览', font=font, fill='#e3ecf7')
draw.text((198, 226), '流动极光柔光边缘 / 蓝色箭头指针', font=small, fill='#90a3bb')
draw.line((198, 267, 760, 267), fill='#303c4d', width=1)
for index, width in enumerate((260, 390, 210)):
    draw.rounded_rectangle((198, 296+index*27, 198+width, 304+index*27), 4, fill='#2b3648')
cursor = Image.open(directory / 'pointer-blue.png').convert('RGBA')
cursor.thumbnail((180, 126), Image.Resampling.LANCZOS)
background.alpha_composite(cursor, (596, 292))
frames = []
for path in sorted(directory.glob('frame-*.png')):
    result = Image.alpha_composite(background, Image.open(path).convert('RGBA')).convert('RGB')
    if not frames:
        result.save(directory / 'overlay-preview.png')
    frames.append(result)
frames[0].save(directory / 'overlay-preview.gif', save_all=True, append_images=frames[1:], duration=250, loop=0, optimize=True, disposal=2)
print(json.dumps({'png': str(directory / 'overlay-preview.png'), 'gif': str(directory / 'overlay-preview.gif'), 'frames': len(frames), 'gifBytes': (directory / 'overlay-preview.gif').stat().st_size}))
