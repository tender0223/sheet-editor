# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = [('static', 'static')]
binaries = []
hiddenimports = ['clr', 'tarfile', 'lzma', '_lzma']
tmp_ret = collect_all('pythonnet')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('clr_loader')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'PIL',
        'numpy',
        'pandas',
        'matplotlib',
        'scipy',
        'cryptography',
        'lxml',
        'pyarrow',
        'IPython',
        'pytest',
        'setuptools',
        'pkg_resources',
        'pydoc_data',
        'unittest',
        'sqlite3',
        'lib2to3',
        'distutils',
        'tkinter',
        '_tkinter',
        'tcl',
        'tk',
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='表格编辑器',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version='tools/version_info.txt',
    icon=['tools/appicon.ico'],
)
