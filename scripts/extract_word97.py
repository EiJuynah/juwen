"""
Word 97-2003 二进制 .doc 正文提取。

用途：本机 0个人资料/中国共产党统一战线工作条例.wps 实际是 Word 97 二进制文档
（OLE2 容器内含 WordDocument + 0Table 流），扩展名却是 .wps，
走编辑器只能拿到被截断到 200 字的预览，所以直接解析二进制。

实现要点：Word 97 的正文不连续存放，必须按 FIB → CLX → PlcPcd 逐段还原。

用法：
    python extract_word97.py <输入文件> [输出txt]
"""
import struct
import sys

import olefile

# FIB 中 fcClx / lcbClx 的位置（Word 97 FIB，紧跟在 cbRgFcLcb 之后）
FIB_FC_CLX_OFF = 0x01A2
FIB_LCB_CLX_OFF = 0x01A6
# FibBase.flags1 的 fWhichTblStm 位（bit 9）决定用 0Table 还是 1Table
FIB_FLAGS1_OFF = 0x000A
FIB_FLAG_WHICHTBLSTM = 0x0200


def _read_stream(ole, name):
    with ole.openstream(name) as f:
        return f.read()


def _decode_ansi(data):
    """压缩片段用 CP1252；个别字节在 CP1252 无定义，用 latin-1 兜底。"""
    out = []
    for b in data:
        try:
            out.append(bytes([b]).decode('cp1252'))
        except UnicodeDecodeError:
            out.append(chr(b))
    return ''.join(out)


def extract(path):
    if not olefile.isOleFile(path):
        raise ValueError('不是 OLE2 复合文档')

    ole = olefile.OleFileIO(path)
    try:
        stream_names = {'/'.join(e) for e in ole.listdir()}
        if 'WordDocument' not in stream_names:
            raise ValueError('缺少 WordDocument 流，可能不是 Word 文档')

        wd = _read_stream(ole, 'WordDocument')

        flags1 = struct.unpack_from('<H', wd, FIB_FLAGS1_OFF)[0]
        table_name = '1Table' if (flags1 & FIB_FLAG_WHICHTBLSTM) else '0Table'
        if table_name not in stream_names:
            # 极少数文档标记与实际表流不一致，回退到存在的那个
            table_name = '0Table' if '0Table' in stream_names else '1Table'
        table = _read_stream(ole, table_name)

        fc_clx, lcb_clx = struct.unpack_from('<II', wd, FIB_FC_CLX_OFF)
        clx = table[fc_clx:fc_clx + lcb_clx]

        # CLX = 若干 Prc(0x01) + 一个 Pcdt(0x02)
        pos = 0
        plc_pcd = None
        while pos < len(clx):
            clxt = clx[pos]
            if clxt == 0x01:                       # Prc：跳过
                cb = struct.unpack_from('<h', clx, pos + 1)[0]
                pos += 3 + cb
            elif clxt == 0x02:                     # Pcdt：本体的 PlcPcd
                lcb = struct.unpack_from('<I', clx, pos + 1)[0]
                plc_pcd = clx[pos + 5:pos + 5 + lcb]
                break
            else:
                break
        if plc_pcd is None:
            raise ValueError('CLX 中未找到 Pcdt')

        # PlcPcd： (n+1) 个 CP + n 个 PCD（每个 8 字节）
        n = (len(plc_pcd) - 4) // 12
        cps = struct.unpack_from('<%dI' % (n + 1), plc_pcd, 0)
        pcd_base = 4 * (n + 1)

        pieces = []
        for i in range(n):
            fc = struct.unpack_from('<I', plc_pcd, pcd_base + i * 8 + 2)[0]
            char_count = cps[i + 1] - cps[i]
            if fc & 0x40000000:                    # 压缩：CP1252，偏移要除 2
                offset = (fc & 0x3FFFFFFF) // 2
                raw = wd[offset:offset + char_count]
                text = _decode_ansi(raw)
            else:                                  # 未压缩：UTF-16LE
                offset = fc & 0x3FFFFFFF
                raw = wd[offset:offset + char_count * 2]
                text = raw.decode('utf-16-le', errors='replace')
            pieces.append(text)

        return ''.join(pieces)
    finally:
        ole.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = sys.argv[1]
    text = extract(src)
    if len(sys.argv) >= 3:
        with open(sys.argv[2], 'w', encoding='utf-8') as f:
            f.write(text)
        print('已写出 %s（%d 字符）' % (sys.argv[2], len(text)))
    else:
        sys.stdout.reconfigure(encoding='utf-8')
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
