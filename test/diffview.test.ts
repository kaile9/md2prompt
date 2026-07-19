import { describe, expect, test } from 'bun:test';
import { project, sentDiff } from '../src/core/diffview';

describe('sentDiff（句级显示粒度，v1.2）', () => {
  test('无句读的一行：整句替换（不再出现逐词碎片）', () => {
    expect(sentDiff('协议 very 重要', '协议 非常 重要')).toEqual([
      { type: 'del', text: '协议 very 重要' },
      { type: 'ins', text: '协议 非常 重要' },
    ]);
  });

  test('CJK 句号切句：相同句保留，改动句整句置换', () => {
    expect(sentDiff('今天天气好。我们去散步。', '今天天气好。我们去跑步。')).toEqual([
      { type: 'same', text: '今天天气好。' },
      { type: 'del', text: '我们去散步。' },
      { type: 'ins', text: '我们去跑步。' },
    ]);
  });

  test('西文句号+空格切句', () => {
    expect(sentDiff('The sky is blue. It rains.', 'The sky is blue. It snows.')).toEqual([
      { type: 'same', text: 'The sky is blue.' },
      { type: 'del', text: ' It rains.' },
      { type: 'ins', text: ' It snows.' },
    ]);
  });

  test('换行硬切句；终止符后闭引号并入本句', () => {
    expect(sentDiff('line1\nline2', 'line1\nline3')).toEqual([
      { type: 'same', text: 'line1\n' },
      { type: 'del', text: 'line2' },
      { type: 'ins', text: 'line3' },
    ]);
    expect(sentDiff('他说「好。」就走了。', '他说「行。」就走了。')).toEqual([
      { type: 'del', text: '他说「好。」' },
      { type: 'ins', text: '他说「行。」' },
      { type: 'same', text: '就走了。' },
    ]);
  });

  test('小数点/缩略语不误切（1.5 后随数字；e.g. 的切分双侧一致无害）', () => {
    const segs = sentDiff('长 1.5 meters.', '长 2.5 meters.');
    // 1.5 内不切，整句只有一处差异 → 整句置换
    expect(segs).toEqual([
      { type: 'del', text: '长 1.5 meters.' },
      { type: 'ins', text: '长 2.5 meters.' },
    ]);
  });

  test('文件名/版本号/缩略语不腰斩（BUG 1b：`SKILL.md`、v1.5.2、e.g.）', () => {
    // 后随小写/CJK 不切；后随大写才切
    expect(sentDiff('this `SKILL.md` is the whole skill.', 'this `SKILL.md` was the whole skill.')).toEqual([
      { type: 'del', text: 'this `SKILL.md` is the whole skill.' },
      { type: 'ins', text: 'this `SKILL.md` was the whole skill.' },
    ]);
    expect(sentDiff('升级到 v1.5.2 起生效。Next sentence here.', '升级到 v1.5.2 起失效。Next sentence here.')).toEqual([
      { type: 'del', text: '升级到 v1.5.2 起生效。' },
      { type: 'ins', text: '升级到 v1.5.2 起失效。' },
      { type: 'same', text: 'Next sentence here.' },
    ]);
    expect(sentDiff('use e.g. this one. Try it.', 'use e.g. that one. Try it.')).toEqual([
      { type: 'del', text: 'use e.g. this one.' },
      { type: 'ins', text: 'use e.g. that one.' },
      { type: 'same', text: ' Try it.' },
    ]);
  });

  test('还原不变量：same+del=before，same+ins=after', () => {
    const before = '第一段 keep 不变。第二段 remove 掉。';
    const after = '第一段 keep 不变。new 段落 add 进来。';
    const segs = sentDiff(before, after);
    const pick = (t: string) => segs.filter((s) => s.type !== t).map((s) => s.text).join('');
    expect(pick('ins')).toBe(before);
    expect(pick('del')).toBe(after);
  });

  test('边界：空串与全同', () => {
    expect(sentDiff('', '新增')).toEqual([{ type: 'ins', text: '新增' }]);
    expect(sentDiff('同', '同')).toEqual([{ type: 'same', text: '同' }]);
    expect(sentDiff('', '')).toEqual([]);
  });

  test('超长句对走护栏降级整段替换', () => {
    const a = '甲。'.repeat(500); // 500 句 × 500 句 > 200k
    const b = '乙。'.repeat(500);
    const segs = sentDiff(a, b);
    expect(segs).toEqual([
      { type: 'del', text: a },
      { type: 'ins', text: b },
    ]);
  });
});

describe('project（源文 → 纯文本坐标投影，M4）', () => {
  test('强调/行内码符号丢弃，map 回切源文', () => {
    const { plain, map } = project('他说**变了**道。');
    expect(plain).toBe('他说变了道。');
    // plain 下标 2（变）→ 源文下标 4（** 之后）
    expect(map[2]).toBe(4);
  });

  test('链接 → 文本；图片/脚注/行内公式 → 单个占位符', () => {
    expect(project('看[这里](https://a.b)吧').plain).toBe('看这里吧');
    expect(project('图![alt](x.png)尾').plain).toBe('图\ufffc尾');
    expect(project('注[^1]释').plain).toBe('注\ufffc释');
    expect(project('算$x+1$式').plain).toBe('算\ufffc式');
  });

  test('含标记句子的句级 diff 可对上 PM 纯文本', () => {
    // M4 原案：after 引入 ** 标记时，投影两侧同规则，ins 段可在 PM 纯文本中定位
    const pb = project('他说道。');
    const pa = project('他说**变了**道。');
    const segs = sentDiff(pb.plain, pa.plain);
    expect(segs).toEqual([
      { type: 'del', text: '他说道。' },
      { type: 'ins', text: '他说变了道。' },
    ]);
    const pmText = '他说变了道。'; // PM 节点纯文本
    expect(pmText.indexOf(segs[1].text, 0)).toBe(0);
  });
});
