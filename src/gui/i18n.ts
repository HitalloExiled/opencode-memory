/**
 * Memory GUI copy. PT-BR and EN-US, following the Opencode locale; anything
 * else falls back to EN-US. Keys missing from PT-BR fall back to EN-US.
 */

import { createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";

export type SupportedLocale = "en-us" | "pt-br";

export function supportedLocale(raw?: string): SupportedLocale {
  const tag = (raw ?? "").trim().toLowerCase().replace(/[-_]/g, "");
  return tag.startsWith("pt") ? "pt-br" : "en-us";
}

const EN = {
  title: "Memory",
  subtitle: "Search past conversations",
  refresh: "Refresh",
  searchLabel: "Search memory",
  searchPlaceholder: "Search past conversations…",
  projectOnly: "This project",
  projectOnlyHint: "Search only sessions of the current project",
  allProjects: "All projects",
  indexStatus: "{0} docs · {1} summaries",
  backend: "Index: {0}",
  recentTitle: "Recent sessions",
  recentEmpty: "No sessions found in this scope.",
  searchEmpty: "No matches.",
  searchHint: "Try another wording or turn off “This project”.",
  resultsCount: "{0} session(s)",
  matches: "{0} match(es)",
  moreMatches: "+{0} more",
  openConversation: "Open conversation",
  addToContext: "Add to context",
  quote: "Quote",
  quoteActions: "Quote selection",
  addToContextTooltip: "Add a truncated quote of this message to the next prompt",
  back: "Back",
  conversation: "Conversation",
  noMessages: "No narrative messages in this page.",
  partial: "Only the active context is available for this session.",
  toolsHidden: "Tool calls hidden",
  selectionHint: "Select text in a message to quote it into the composer.",
  paginate: "Paginate",
  paginateHint: "Switch between infinite scroll and page navigation",
  prevPage: "Previous",
  nextPage: "Next",
  page: "Page {0}",
  loading: "Loading…",
  loadingMore: "Loading more…",
  end: "End of results",
  quoteChars: "Quote size",
  quoteCharsHint: "Characters sent to the agent",
  kindUser: "user",
  kindAssistant: "assistant",
  kindSummary: "summary",
  kindOther: "message",
  sourceLabel: "Memory · {0}",
  sourceSubject: "the memory of a past session",
  "toast.attached": "Quote added to context",
  "toast.attachedHint": "The agent will see the truncated slice and can read around it.",
  "toast.noSession": "No session open",
  "toast.noSessionHint": "Open a session to add memory to the context.",
  "toast.contextUnavailable": "Context unavailable",
  "toast.contextUnavailableHint": "This session's composer doesn't accept quotes right now.",
  "toast.attachError": "Could not add the quote",
  "toast.loadError": "Could not load memory",
  "toast.contentError": "Could not read the message",
};

const PT: Record<keyof typeof EN, string> = {
  title: "Memória",
  subtitle: "Buscar conversas passadas",
  refresh: "Atualizar",
  searchLabel: "Buscar na memória",
  searchPlaceholder: "Buscar em conversas passadas…",
  projectOnly: "Só este projeto",
  projectOnlyHint: "Buscar apenas nas sessões do projeto atual",
  allProjects: "Todos os projetos",
  indexStatus: "{0} docs · {1} resumos",
  backend: "Índice: {0}",
  recentTitle: "Sessões recentes",
  recentEmpty: "Nenhuma sessão encontrada neste escopo.",
  searchEmpty: "Nenhum resultado.",
  searchHint: "Tente outra palavra ou desligue “Só este projeto”.",
  resultsCount: "{0} sessão(ões)",
  matches: "{0} ocorrência(s)",
  moreMatches: "+{0} mais",
  openConversation: "Abrir conversa",
  addToContext: "Adicionar ao contexto",
  quote: "Quotar",
  quoteActions: "Citar seleção",
  addToContextTooltip: "Adiciona um trecho truncado desta mensagem ao próximo prompt",
  back: "Voltar",
  conversation: "Conversa",
  noMessages: "Nenhuma mensagem narrativa nesta página.",
  partial: "Apenas o contexto ativo está disponível para esta sessão.",
  toolsHidden: "Chamadas de ferramenta ocultas",
  selectionHint: "Selecione um texto em uma mensagem para citá-lo no composer.",
  paginate: "Paginar",
  paginateHint: "Alternar entre scroll infinito e navegação por páginas",
  prevPage: "Anterior",
  nextPage: "Próxima",
  page: "Página {0}",
  loading: "Carregando…",
  loadingMore: "Carregando mais…",
  end: "Fim dos resultados",
  quoteChars: "Tamanho do trecho",
  quoteCharsHint: "Caracteres enviados ao agente",
  kindUser: "usuário",
  kindAssistant: "assistente",
  kindSummary: "resumo",
  kindOther: "mensagem",
  sourceLabel: "Memória · {0}",
  sourceSubject: "a memória de uma sessão passada",
  "toast.attached": "Trecho adicionado ao contexto",
  "toast.attachedHint": "O agente verá o trecho truncado e poderá ler o entorno.",
  "toast.noSession": "Nenhuma sessão aberta",
  "toast.noSessionHint": "Abra uma sessão para adicionar memória ao contexto.",
  "toast.contextUnavailable": "Contexto indisponível",
  "toast.contextUnavailableHint": "O composer desta sessão não aceita quotes agora.",
  "toast.attachError": "Não foi possível adicionar o trecho",
  "toast.loadError": "Não foi possível carregar a memória",
  "toast.contentError": "Não foi possível ler a mensagem",
};

const tables: Record<SupportedLocale, Record<string, string>> = {
  "en-us": EN,
  "pt-br": { ...EN, ...PT },
};

export function useLocale(): Accessor<SupportedLocale> {
  const ctx = usePlugin();
  return createMemo(() => supportedLocale(ctx.locale.locale()));
}

export function useT(): (key: string, ...args: unknown[]) => string {
  const locale = useLocale();
  return (key: string, ...args: unknown[]): string => {
    const table = tables[locale()];
    const value = table[key] ?? (typeof args[0] === "string" ? args[0] : key);
    return value.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ""));
  };
}
