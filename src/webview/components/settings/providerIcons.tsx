import React from 'react';

/**
 * Accurate provider brand marks.
 * - OpenAI / Anthropic / Gemini / Vercel / Alibaba Cloud / Hugging Face /
 *   NVIDIA / DeepSeek / Moonshot AI / Mistral AI: official simple-icons path data.
 * - Remaining brands (xAI, Groq, Cohere, Together, Fireworks, DeepInfra,
 *   Cerebras, Baseten): hand-drawn approximations using official brand colors
 *   (their marks are not in simple-icons).
 */

type IconProps = { className?: string };

const S = 'w-5 h-5';

/* ── Official simple-icons marks ── */

export const OpenAIIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#10A37F" className={className} aria-hidden="true">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

export const AnthropicIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#D97757" className={className} aria-hidden="true">
    <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
  </svg>
);

export const GeminiIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="fib-gemini-g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#4285F4" />
        <stop offset="38%" stopColor="#9B72CB" />
        <stop offset="70%" stopColor="#D96570" />
        <stop offset="100%" stopColor="#F2A60C" />
      </linearGradient>
    </defs>
    <path
      fill="url(#fib-gemini-g)"
      d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
    />
  </svg>
);

export const VercelIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M24 22.525H0l12-21.05 12 21.05z" />
  </svg>
);

export const AlibabaCloudIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#FF6A00" className={className} aria-hidden="true">
    <path d="M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z" />
  </svg>
);

export const HuggingFaceIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#FFD21E" className={className} aria-hidden="true">
    <path d="M12.0234 1.24219c-5.84262 0-10.57884 4.7074-10.57884 10.51431 0 1.1021.16733 2.1585.48476 3.1563-.03785-.0028-.06915-.0058-.10586-.0058-.42086 0-.80147.16-1.07044.4512-.34532.3737-.49835.8335-.43157 1.293a1.576 1.576 0 0 0 .21481.5978c-.23194.1864-.40176.4456-.48437.7578-.0646.2448-.13099.7543.2149 1.2794a1.45523 1.45523 0 0 0-.0625.1055c-.20797.3923-.22073.8372-.0371 1.25.2783.6258.9696 1.1175 2.3126 1.6467.8356.3292 1.5988.5411 1.6056.543 1.1046.2847 2.104.4277 2.969.4277 1.4173 0 2.4754-.3849 3.1525-1.1446 1.538.2651 2.791.1403 3.592.006.6773.7555 1.7332 1.1387 3.1467 1.1387.8649 0 1.8643-.143 2.969-.4278.0068-.0019.77-.2138 1.6056-.543 1.343-.5292 2.0343-1.0208 2.3126-1.6466.1836-.4129.171-.8577-.037-1.25a1.46853 1.46853 0 0 0-.0626-.1056c.346-.525.2795-1.0346.2149-1.2793-.0826-.3122-.2525-.5714-.4844-.7579.11-.1816.1831-.3788.2148-.5977.0669-.4595-.0862-.9193-.4316-1.293-.2688-.2913-.6495-.4513-1.0704-.4513-.0209 0-.0376.0008-.0588.0018.3162-.9966.4846-2.0518.4846-3.1523 0-5.80701-4.7362-10.51441-10.5789-10.51441Zm0 1.0313c5.2727 0 9.5476 4.246 9.5476 9.48301a9.42012 9.42012 0 0 1-.2696 2.2365c-.0039-.0047-.0079-.011-.0117-.0156-.274-.3255-.6679-.5059-1.1075-.5059-.352 0-.714.1155-1.0763.3438-.2403.1517-.5058.422-.7793.7598-.2534-.3492-.608-.5832-1.0137-.6465a1.5171 1.5171 0 0 0-.2344-.0176c-.9263 0-1.4828.7993-1.6935 1.5177-.1046.2426-.6065 1.3482-1.3614 2.0978-1.1681 1.1601-1.4458 2.3534-.8396 3.6382-.843.1029-1.5836.0927-2.365-.006.5906-1.212.3626-2.4388-.8426-3.6322-.755-.7496-1.2568-1.8552-1.3614-2.0978-.2107-.7184-.7673-1.5177-1.6935-1.5177-.078 0-.1568.0054-.2344.0176-.4057.0633-.7604.2973-1.0137.6465-.2735-.3379-.539-.6081-.7794-.7598-.3622-.2283-.7243-.3438-1.0762-.3438-.4266 0-.8094.171-1.0821.4786a9.42078 9.42078 0 0 1-.2598-2.1936c0-5.23711 4.2749-9.48311 9.5475-9.48311ZM8.6443 7.0036c-.4838.0043-.9503.2667-1.1934.7227-.3536.6633-.1006 1.4873.5645 1.84.351.1862.4883-.5261.836-.6485.3107-.1095.841.399 1.0078.086.3536-.6634.1025-1.4874-.5625-1.84a1.36594 1.36594 0 0 0-.6524-.1602Zm6.8403 0c-.2199-.002-.4426.05-.6504.1602-.665.3526-.9181 1.1766-.5645 1.84.1669.313.6971-.1955 1.0079-.086.3476.1224.4867.8347.838.6485.6649-.3527.916-1.1767.5624-1.84-.243-.456-.7096-.7184-1.1934-.7227Zm-9.7565 1.418a.8768.8768 0 0 0-.877.877c0 .4846.3925.877.877.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zm12.6434 0c-.4845 0-.879.3925-.879.877 0 .4846.3945.877.879.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zM8.7927 11.459c-.179-.003-.2793.1107-.2793.416 0 .8097.3874 2.125 1.4279 2.924.207-.7123 1.3453-1.2832 1.5079-1.2012.2315.1167.2191.4417.6074.7266.3884-.285.374-.6098.6056-.7266.1627-.082 1.3009.4889 1.5079 1.2012 1.0404-.799 1.4278-2.1144 1.4278-2.924 0-1.2212-1.583.6402-3.5413.6485-1.4686-.0061-2.7266-1.0558-3.2639-1.0645z" />
  </svg>
);

export const NvidiaIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#76B900" className={className} aria-hidden="true">
    <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.991 1.594 3.505 1.94C17.783 19.688 9.132 22.456 2.58 20.23c-1.331-.452-2.075-.94-2.58-1.755V2.528C1.235.57 6.383-.234 9.198.518v2.366c-2.27-.618-5.21-.546-6.918.928 2.32-1.354 6.21-1.191 8.003.377M2.981 7.368v5.176c1.526.284 3.39.062 4.14-.246V9.527c0-1.398 2.032-2.16 3.826-2.155v-1.34c-3.128-.229-7.966.466-7.966 1.336" />
  </svg>
);

/* ── Hand-drawn marks in official brand colors (simple-icons removed these) ── */

export const XaiIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    {/* xAI lattice X: one full diagonal + two half-arms meeting at center */}
    <path d="M2 2h4.4L22 22h-4.4L2 2z" />
    <path d="M22 2v4.2L9.2 22H5L22 2z" opacity="0.92" />
  </svg>
);

export const MistralIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#FA500F" className={className} aria-hidden="true">
    {/* Official simple-icons mark (mistralai) */}
    <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
  </svg>
);

export const GroqIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#F55036" className={className} aria-hidden="true">
    {/* Four rounded petals around a square core — Groq spark mark */}
    <rect x="10" y="1.5" width="4" height="9" rx="2" />
    <rect x="10" y="13.5" width="4" height="9" rx="2" />
    <rect x="1.5" y="10" width="9" height="4" rx="2" />
    <rect x="13.5" y="10" width="9" height="4" rx="2" />
    <rect x="9" y="9" width="6" height="6" rx="1.2" />
  </svg>
);

export const CohereIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    {/* Pinwheel of four capsule arcs — Cohere mark colors */}
    <path d="M11 2.5c-4.7.4-8.1 3.8-8.5 8.5H11V2.5z" fill="#FF675F" />
    <path d="M13 21.5c4.7-.4 8.1-3.8 8.5-8.5H13v8.5z" fill="#FF675F" />
    <path d="M2.5 13c.4 4.7 3.8 8.1 8.5 8.5V13H2.5z" fill="#D18EE2" />
    <path d="M21.5 11c-.4-4.7-3.8-8.1-8.5-8.5V11h8.5z" fill="#39594D" />
    <circle cx="12" cy="12" r="2.6" fill="#FFB70F" />
  </svg>
);

export const DeepSeekIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#4D6BFE" className={className} aria-hidden="true">
    {/* Official simple-icons mark (deepseek) */}
    <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
  </svg>
);

export const MoonshotIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="#1E2A5E" className={className} aria-hidden="true">
    {/* Official simple-icons mark (moonshotai) */}
    <path d="m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866" />
  </svg>
);

export const TogetherIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="fib-together-g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#0F6FFF" />
        <stop offset="100%" stopColor="#8B5CF6" />
      </linearGradient>
    </defs>
    {/* Abstract delta/T network — Together AI gradient */}
    <path d="M4 4h16a1.6 1.6 0 0 1 0 3.2h-6.4V20a1.6 1.6 0 0 1-3.2 0V7.2H4A1.6 1.6 0 0 1 4 4z" fill="url(#fib-together-g)" />
    <circle cx="4.2" cy="19.8" r="2.1" fill="url(#fib-together-g)" opacity="0.85" />
    <circle cx="19.8" cy="19.8" r="2.1" fill="url(#fib-together-g)" opacity="0.85" />
  </svg>
);

export const FireworksIcon: React.FC<IconProps> = ({ className = S }) => {
  const rays = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  const cx = 12;
  const cy = 12;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="fib-fireworks-g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF6B2C" />
          <stop offset="100%" stopColor="#FF0381" />
        </linearGradient>
      </defs>
      {rays.map((a, i) => (
        <line
          key={i}
          x1={cx + Math.cos(a) * 5.2}
          y1={cy + Math.sin(a) * 5.2}
          x2={cx + Math.cos(a) * 9.6}
          y2={cy + Math.sin(a) * 9.6}
          stroke="url(#fib-fireworks-g)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      ))}
      <circle cx={cx} cy={cy} r="2.6" fill="url(#fib-fireworks-g)" />
    </svg>
  );
};

export const DeepInfraIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="fib-deepinfra-g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#22D3EE" />
        <stop offset="100%" stopColor="#4F46E5" />
      </linearGradient>
    </defs>
    <path d="M6.5 3.6 20 12 6.5 20.4a1.8 1.8 0 0 1-2.7-1.6V5.2a1.8 1.8 0 0 1 2.7-1.6z" fill="url(#fib-deepinfra-g)" />
    <path d="M8.4 8.4 15 12l-6.6 3.6V8.4z" fill="#fff" opacity="0.9" />
  </svg>
);

export const CerebrasIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#F26522" strokeWidth="2.1" strokeLinecap="square" className={className} aria-hidden="true">
    {/* Squared spiral — Cerebras mark */}
    <path d="M3.5 3.5h17v17h-17v-12h12v7h-7v-2h2" />
  </svg>
);

export const BasetenIcon: React.FC<IconProps> = ({ className = S }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="fib-baseten-g" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#6366F1" />
        <stop offset="100%" stopColor="#A855F7" />
      </linearGradient>
    </defs>
    {/* Stacked platform layers — Baseten */}
    <path d="M12 2.6 21 7.4 12 12.2 3 7.4l9-4.8z" fill="url(#fib-baseten-g)" />
    <path d="m3 12.2 9 4.8 9-4.8" fill="none" stroke="url(#fib-baseten-g)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m3 16.8 9 4.8 9-4.8" fill="none" stroke="url(#fib-baseten-g)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
  </svg>
);

/** Lookup by provider id used across the settings UI. */
export const PROVIDER_BRAND_ICONS: Record<string, React.FC<IconProps>> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  google: GeminiIcon,
  xai: XaiIcon,
  vercel: VercelIcon,
  mistral: MistralIcon,
  groq: GroqIcon,
  cohere: CohereIcon,
  deepseek: DeepSeekIcon,
  moonshotai: MoonshotIcon,
  together: TogetherIcon,
  fireworks: FireworksIcon,
  alibaba: AlibabaCloudIcon,
  deepinfra: DeepInfraIcon,
  cerebras: CerebrasIcon,
  huggingface: HuggingFaceIcon,
  baseten: BasetenIcon,
  nvidia: NvidiaIcon,
};
