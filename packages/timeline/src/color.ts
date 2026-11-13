// FFmpeg's named colors and its two built-in random color keywords.
const names = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod
darkgray darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkturquoise darkviolet deeppink deepskyblue dimgray dodgerblue firebrick
floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow honeydew hotpink
indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod
palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple red rosybrown
royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray snow
springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen random bikeshed`.split(/\s+/));

/** Parse a color token before it crosses into FFmpeg's filter graph grammar. */
export function parseColor(input: string): { color: string; alpha: number; explicitAlpha: boolean } | undefined {
  const parts = input.trim().toLowerCase().split("@", 3);
  const base = parts[0]!;
  if (parts.length > 2) return undefined;
  let color: string;
  let alpha = 1;
  if (names.has(base)) {
    color = base;
  } else {
    let hex = base.replace(/^(?:#|0x)/, "");
    if (/^(?:#|0x)/.test(base) && /^[a-f0-9]{3,4}$/.test(hex)) {
      hex = [...hex].map((c) => c + c).join("");
    }
    if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(hex)) return undefined;
    color = `0x${hex.slice(0, 6).toUpperCase()}`;
    if (hex.length === 8) alpha = parseInt(hex.slice(6), 16) / 255;
  }
  const suffix = parts[1]?.trim();
  if (suffix !== undefined) {
    if (/^0x[0-9a-f]+$/.test(suffix)) alpha = parseInt(suffix, 16) / 255;
    else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(suffix)) alpha = Number(suffix);
    else return undefined;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return undefined;
  }
  return { color, alpha, explicitAlpha: suffix !== undefined };
}
