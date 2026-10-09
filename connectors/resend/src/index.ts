import { defineConnector } from "@sanoma/workflows";
import { z } from "zod";

/**
 * Resend's lettermark, from https://resend.com/brand (resend-icon-black.svg, resend-icon-white.svg),
 * in its official colours, its view box cropped to the mark.
 */
const lettermark = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="450 450 900 900"><path fill="${fill}" d="M1000.46 450C1174.77 450 1278.43 553.669 1278.43 691.282C1278.43 828.896 1174.77 932.563 1000.46 932.563H912.382L1350 1350H1040.82L707.794 1033.48C683.944 1011.47 672.936 985.781 672.935 963.765C672.935 932.572 694.959 905.049 737.161 893.122L908.712 847.244C973.85 829.812 1018.81 779.353 1018.81 713.298C1018.8 632.567 952.745 585.78 871.095 585.78H450V450H1000.46Z"/></svg>`;

/** Resend Broadcasts API: https://resend.com/docs/api-reference/broadcasts */
export const resend = defineConnector(
  "resend",
  {
    broadcast: {
      create: {
        effect: "write",
        description: "Create a broadcast to an audience. Nothing is sent.",
        input: z.object({
          audience: z.string().min(1),
          from: z.string().optional(),
          subject: z.string().min(1),
          html: z.string(),
        }),
        output: z.object({ id: z.string() }),
      },
      send: {
        effect: "send",
        description: "Send a broadcast to every contact in its audience. Cannot be undone.",
        phrases: { expect: "broadcast {id} is sent" },
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), status: z.enum(["queued", "sent"]) }),
      },
    },
  },
  {
    title: "Resend",
    logo: { svg: lettermark("black"), dark: lettermark("#FDFDFD") },
    package: "@sanoma/connector-resend",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/resend#readme",
  },
);
