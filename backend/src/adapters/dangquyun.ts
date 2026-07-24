/**
 * 当曲云平台适配器（当前为演示用 mock 实现）。
 * 真实接入时，替换本文件内部实现为当曲云开放 API 调用（账号+API凭证），
 * 对外暴露的函数签名保持不变，上层同步逻辑无需改动。
 */
import dayjs from "dayjs";
import { Ticket } from "../types";
import { genTicket } from "../seed";

export async function fetchNewDangquyunTickets(count: number, nextSeqStart: number, year: number): Promise<Ticket[]> {
  await new Promise((r) => setTimeout(r, 20));
  const now = dayjs();
  return Array.from({ length: count }).map((_, i) =>
    genTicket(year, nextSeqStart + i, now.subtract(Math.floor(Math.random() * 30), "minute"))
  );
}
