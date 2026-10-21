import { Fragment, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Cpu,
  Download,
  FileArchive,
  Folder,
  FolderPlus,
  Folders,
  LifeBuoy,
  MoreHorizontal,
  Palette,
  Play,
  Plug,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
  SearchIcon,
  DollarSign,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  CostSummary,
  DriveFolder,
  LocalModelFit,
  CodexAuthStatus,
  McpServerInfo,
  ProviderId,
  SettingsView,
  SkillInfo,
  WorkspaceInfo,
} from "../../shared/ipc";
import {
  AUTH_MODES,
  GMAIL_INGEST_LABEL,
  type AuthMode,
  jobKind,
  nextJobRun,
  type ScheduledJob,
} from "../../shared/ipc";
import {
  PROVIDER_VENDORS,
  PROVIDERS,
  providerHealth,
  type ProviderHealth,
  type ProviderMeta,
} from "../lib/models";
import { BRAIN_TEMPLATES } from "../../shared/brainTemplates";
import { ClaudeLoginFlow } from "./ClaudeLoginCard";
import { CONNECTOR_CATALOG } from "../../shared/connectorCatalog";
import { ConnectorIcon } from "./ConnectorIcon";
import {
  BUILTIN_TOOL_OPTIONS,
  GOOGLE_TOOL_OPTIONS,
  connectorToolOption,
  customToolOption,
  type ToolOption,
} from "../../shared/toolCatalog";
import { ToolPicker } from "./ToolPicker";
import { UpdateControls } from "./UpdateControls";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  COLOR_SCHEMES,
  type ColorScheme,
  DEFAULT_TOKENS,
  THEMES,
  setScheme,
  setTheme,
  useScheme,
  useThemeId,
} from "../lib/theme";
import { useStore } from "../store";
import { api } from "../rpc";
import { onEnter } from "../util";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";

// The graph viewer pulls in a force-layout canvas engine — loaded only when
// the section is opened, not with the app.
const KnowledgeGraphView = lazy(() =>
  import("./KnowledgeGraphView").then((m) => ({
    default: m.KnowledgeGraphView,
  })),
);

const SECTIONS = [
  { id: "workspaces", label: "Workspaces", icon: Folders },
  { id: "graph", label: "Knowledge graph", icon: Waypoints },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "google", label: "Google", icon: Cloud },
  { id: "troubleshooting", label: "Troubleshooting", icon: LifeBuoy },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SECTION_IDS = SECTIONS.map((s) => s.id) as readonly string[];

function useSection(): SectionId {
  const stored = useStore((s) => s.settingsSection);
  return (SECTION_IDS.includes(stored) ? stored : "workspaces") as SectionId;
}

/** The settings section list, rendered by Sidebar in place of the thread list
 *  while settings are open. It lives here, next to the sections it switches
 *  between, but it is drawn inside the one shared sidebar panel — so settings
 *  inherit that panel's width, its drag handle, and ⌘B, instead of standing up
 *  a second nav of their own. */
export function SettingsNav() {
  const setOpen = useStore((s) => s.setSettingsOpen);
  const setSection = useStore((s) => s.setSettingsSection);
  const section = useSection();

  return (
    <>
      <div className="space-y-0.5 flex-1 px-3">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm",
              section === id
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            onClick={() => setSection(id)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <UpdatesFooter />
        <Button variant="ghost" onClick={() => setOpen(false)}>
          <ArrowLeft size={15} /> Back
        </Button>
      </div>
    </>
  );
}

/** Settings content pane. Fills the main panel (over the chat, which stays
 *  mounted underneath so closing returns you to exactly where you were) while
 *  the sidebar beside it shows SettingsNav. */
export function SettingsPage() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const section = useSection();

  useEffect(() => {
    if (open) void api.getSettings();
  }, [open]);

  // The section list lives in the sidebar now, so an open settings page with a
  // collapsed sidebar has no visible nav. Opening from the chat header (where
  // the sidebar may well be shut) would otherwise strand you on one section.
  useEffect(() => {
    if (open) useStore.getState().setSidebarCollapsed(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Claimed, or AppKit answers the unhandled key with the alert beep.
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    // Absolute inside the main panel, not fixed over the window: the sidebar
    // and its handle stay live beside it. z-10 keeps it over the chat but under
    // the sidebar toggle (z-30) and the dialogs (z-50).
    <div className="absolute inset-0 z-10 flex flex-col bg-background text-foreground">
      {/* Collapsed, this bar slides under the traffic lights and the fixed
          sidebar toggle, so it indents to where they end — same rule as the
          chat header. Expanded, the sidebar holds that space. */}
      <header
        className={cn(
          "flex items-center h-12 pr-8 shrink-0 electrobun-webkit-app-region-drag",
          collapsed ? "pl-(--titlebar-content-x)" : "pl-8",
        )}
      >
        <span className="text-sm text-muted-foreground">Settings</span>
      </header>
      {/* scrollbar-gutter: the scrollbar's width is reserved whether or not
          this section overflows, so switching between a short section and a
          long one doesn't nudge the column sideways as the bar comes and
          goes. both-edges keeps the centered column truly centered. */}
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges] px-8 pt-10 pb-28">
        {/* One centered column with wide gutters — the settings read as a
            document, not as a panel pinned to the window's left edge. */}
        <div
          className={cn(
            "mx-auto w-full",
            // The graph is a canvas, not a document — it gets the room.
            section === "graph" ? "max-w-6xl" : "max-w-3xl",
          )}
        >
          {section === "workspaces" && <WorkspacesSection />}
          {section === "graph" && <KnowledgeGraphSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "skills" && <SkillsSection />}
          {section === "connectors" && <ConnectorsSection />}
          {section === "providers" && <ProvidersSection />}
          {section === "google" && <GoogleClientSection />}
          {section === "troubleshooting" && <TroubleshootingSection />}
        </div>
      </div>
    </div>
  );
}

/** Section heading in the page's own scale — bigger than the old dialog's. */
function SectionHeader({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight flex-1">
          {title}
        </h1>
        {action}
      </div>
      {children && (
        // Capped at a readable measure rather than the column width.
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground mt-2 max-w-[62ch]">
          {children}
        </p>
      )}
    </div>
  );
}

/** Appearance: color scheme (System/Light/Dark, T3-style mock-window cards)
 *  above the theme picker (cards with two preview orbs). Applying either is
 *  instant and live — the settings page itself repaints in the new palette,
 *  which is the whole preview. */
function AppearanceSection() {
  const themeId = useThemeId();
  const scheme = useScheme();

  return (
    <section>
      <SectionHeader title="Appearance">
        Choose how Monad looks. Pick a color scheme, then a theme — every theme
        ships a light and a dark variant, and System follows macOS. Both choices
        are saved on this machine.
      </SectionHeader>

      <h2 className="mb-3 text-base font-semibold tracking-tight">
        Color scheme
      </h2>
      <div className="mb-10 grid grid-cols-3 gap-3">
        {COLOR_SCHEMES.map((s) => (
          <SchemeCard key={s} scheme={s} selected={s === scheme} />
        ))}
      </div>

      <h2 className="mb-3 text-base font-semibold tracking-tight">Themes</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => {
          const selected = t.id === themeId;
          return (
            <button
              type="button"
              key={t.id}
              aria-pressed={selected}
              className={cn(
                "rounded-xl border p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                selected
                  ? "border-brand/60 bg-muted/40"
                  : "border-border hover:bg-muted/30",
              )}
              onClick={() => setTheme(t.id)}
            >
              <div className="mb-4 flex items-center gap-3">
                <ThemeOrb color={t.preview.accent} ringed={selected} />
                <ThemeOrb color={t.preview.surface} ringed={selected} />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{t.label}</span>
                {selected && <Check size={13} className="text-brand" />}
              </div>
              <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                {t.tagline}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const SCHEME_LABELS: Record<ColorScheme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function SchemeCard({
  scheme,
  selected,
}: {
  scheme: ColorScheme;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "rounded-xl border p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected
          ? "border-brand/60 bg-muted/40"
          : "border-border hover:bg-muted/30",
      )}
      onClick={() => setScheme(scheme)}
    >
      <div className="relative aspect-[16/10]">
        {scheme !== "dark" && <SchemeMock dark={false} />}
        {scheme === "dark" && <SchemeMock dark />}
        {scheme === "system" && (
          // Right half re-drawn dark: the T3-style split preview.
          <div
            className="absolute inset-0"
            style={{ clipPath: "inset(0 0 0 50%)" }}
          >
            <SchemeMock dark />
          </div>
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-center gap-1.5">
        <span className="text-sm font-medium">{SCHEME_LABELS[scheme]}</span>
        {selected && <Check size={13} className="text-brand" />}
      </div>
    </button>
  );
}

/** Miniature app window painted from the selected theme's tokens for the
 *  given scheme — so a light mock stays true to the theme even while the app
 *  itself is rendering dark, and vice versa. DEFAULT_TOKENS fills whatever a
 *  theme doesn't override (all of Carbon; status colors for everyone). */
function SchemeMock({ dark }: { dark: boolean }) {
  const themeId = useThemeId();
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const mode = dark ? "dark" : "light";
  const vars = { ...DEFAULT_TOKENS[mode], ...theme.vars[mode] };
  const p = {
    bg: vars["--background"],
    side: vars["--sidebar"],
    // Dark borders are near-invisible alpha whites; secondary reads better
    // as the skeleton bars there. Light borders are solid and do fine.
    bar: dark ? vars["--secondary"] : vars["--border"],
    card: vars["--card"],
    edge: vars["--border"],
    brand: vars["--brand"],
  };
  const dots = [vars["--success"], p.brand, vars["--warning"]];
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex overflow-hidden rounded-lg border"
      style={{ background: p.bg, borderColor: p.edge }}
    >
      <div
        className="flex w-[30%] flex-col gap-1.5 border-r p-2"
        style={{ background: p.side, borderColor: p.edge }}
      >
        <div
          className="h-2 w-3/4 rounded-full border"
          style={{ background: p.card, borderColor: p.edge }}
        />
        <div className="h-1.5 rounded-full" style={{ background: p.bar }} />
        <div className="h-1.5 rounded-full" style={{ background: p.bar }} />
        <div
          className="h-1.5 w-2/3 rounded-full"
          style={{ background: p.bar }}
        />
      </div>
      <div className="relative flex-1 p-2">
        <div
          className="mt-1 h-1.5 w-1/2 rounded-full"
          style={{ background: p.bar }}
        />
        <div
          className="mt-1.5 h-1.5 w-2/3 rounded-full"
          style={{ background: p.bar }}
        />
        <div
          className="absolute top-2 right-2 w-[34%] rounded-md border p-1.5"
          style={{ background: p.card, borderColor: p.edge }}
        >
          {dots.map((c) => (
            <div key={c} className="mb-1 flex items-center gap-1 last:mb-0">
              <span
                className="size-1 shrink-0 rounded-full"
                style={{ background: c }}
              />
              <span
                className="h-1 flex-1 rounded-full"
                style={{ background: p.bar }}
              />
            </div>
          ))}
        </div>
        <div
          className="absolute inset-x-2 bottom-2 flex h-4 items-center justify-between rounded-full border px-1"
          style={{ background: p.card, borderColor: p.edge }}
        >
          <span
            className="ml-1 h-1 w-1/2 rounded-full"
            style={{ background: p.bar }}
          />
          <span
            className="size-2.5 rounded-full"
            style={{ background: p.brand }}
          />
        </div>
      </div>
    </div>
  );
}

/** Lit-sphere swatch: a radial highlight over the theme color, so a flat hex
 *  reads as an object rather than a paint chip. */
function ThemeOrb({ color, ringed }: { color: string; ringed: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-10 rounded-full",
        ringed && "ring-2 ring-brand/60 ring-offset-2 ring-offset-background",
      )}
      style={{
        background: `radial-gradient(circle at 32% 28%, color-mix(in oklch, ${color} 55%, white) 0%, ${color} 58%, color-mix(in oklch, ${color} 75%, black) 100%)`,
      }}
    />
  );
}

function WorkspacesSection() {
  const workspaces = useStore((s) => s.workspaces);
  const creating = useStore((s) => s.newWorkspaceOpen);
  const setCreating = useStore((s) => s.setNewWorkspaceOpen);
  const [error, setError] = useState("");

  const addExisting = async () => {
    setError("");
    const path = await api.pickFolder();
    if (!path) return;
    const res = await api.addWorkspaceFromFolder(path);
    if ("error" in res && res.error) setError(res.error);
  };

  const importBrain = async () => {
    setError("");
    const zip = await api.pickFile();
    if (!zip) return;
    if (!zip.toLowerCase().endsWith(".zip"))
      return setError("Pick a .zip exported from Monad.");
    const parent = await api.pickFolder();
    if (!parent) return;
    const name = zip
      .split("/")
      .pop()!
      .replace(/\.zip$/i, "")
      .replace(/-brain(-\d+)?$/, "");
    const res = await api.importWorkspace(zip, parent, name);
    if (res.error) setError(res.error);
  };

  return (
    <section>
      <SectionHeader
        title="Workspaces"
        action={
          // One primary way in; the rarer ways to add a brain live in the menu.
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New workspace
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="More ways to add one"
                  />
                }
              >
                <MoreHorizontal size={15} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => void addExisting()}>
                  <FolderPlus className="size-3" /> Add existing folder…
                </DropdownMenuItem>
                <DropdownMenuItem
                  title="Unzip a brain exported from another Monad; missing credentials show as amber rows"
                  onClick={() => void importBrain()}
                >
                  <Upload className="size-3" /> Import brain (.zip)…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      >
        Each workspace is a folder — its own company brain. Documents,
        knowledge, chats and connections are scoped to it.
      </SectionHeader>

      <NewWorkspaceDialog open={creating} onOpenChange={setCreating} />
      {error && <FieldError className="mb-3 text-xs">{error}</FieldError>}

      <div className="space-y-3">
        {workspaces.map((w) => (
          <WorkspaceCard key={w.id} ws={w} />
        ))}
        {workspaces.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No workspaces yet — create one to give the agent a brain to work in.
          </p>
        )}
      </div>
    </section>
  );
}

/** Type-the-name confirmation for the one irreversible-looking action in
 *  Settings. It is not actually irreversible — the folder goes to the Trash,
 *  not to /dev/null — but the friction is still right: the name has to be
 *  typed, the absolute path is shown, and the backend re-checks both. */
function DeleteWorkspaceDialog({
  ws,
  open,
  onOpenChange,
}: {
  ws: WorkspaceInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<{ confirmName: string }>({
    resolver: zodResolver(
      z.object({
        confirmName: z.literal(ws.name, {
          message: `Type “${ws.name}” exactly to confirm.`,
        }),
      }),
    ),
    defaultValues: { confirmName: "" },
  });
  const rootError = form.formState.errors.root;

  const onSubmit = async () => {
    const res = await api.deleteWorkspace(ws.id, ws.name);
    // The card unmounts on success (the workspace leaves the store), so there
    // is nothing to close — only the failure path needs handling.
    if (!res.ok)
      form.setError("root", { message: res.error ?? "Delete failed." });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) form.reset();
      }}
    >
      <AlertDialogContent className="min-w-md">
        <form
          className="grid gap-4"
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle size={15} /> Delete “{ws.name}”
            </AlertDialogTitle>
            <AlertDialogDescription>
              This moves the whole workspace folder — documents, knowledge,
              chats and all — to the Trash, and unregisters it from Monad. You
              can put it back from the Trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* text-left: the alert-dialog header centres itself at small sizes,
              and a centred absolute path is unreadable. */}
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-left">
            <p className="text-[0.6875rem] text-muted-foreground">
              Folder to delete
            </p>
            <p className="font-mono text-[0.6875rem] break-all text-destructive">
              {ws.path}
            </p>
          </div>
          <FieldGroup>
            <Controller
              name="confirmName"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="ws-confirm">
                    Type the workspace name to confirm
                  </FieldLabel>
                  <Input
                    {...field}
                    id="ws-confirm"
                    autoComplete="off"
                    placeholder={ws.name}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && (
                    <FieldError
                      className="text-[0.6875rem]"
                      errors={[fieldState.error]}
                    />
                  )}
                </Field>
              )}
            />
            {rootError?.message && (
              <FieldError className="text-[0.6875rem]">
                {rootError.message}
              </FieldError>
            )}
          </FieldGroup>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* Not AlertDialogAction: that renders a plain Button outside the
                form's submit path, and the typed name has to go through RHF
                validation before anything is trashed. */}
            <Button
              type="submit"
              variant="destructive"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting && (
                <Loader2 className="animate-spin" />
              )}
              Move to Trash
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Give the workspace a name."),
  templateId: z.string().min(1),
});

type WorkspaceForm = z.infer<typeof workspaceSchema>;

/** Creating a brain is a decision with two inputs and a folder picker at the
 *  end — a dialog keeps that sequence in one place instead of pushing the
 *  workspace list down the page while you fill it in. */
function NewWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<WorkspaceForm>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { name: "", templateId: "generic" },
  });
  // watch, not local state: the description under the picker follows the one
  // value the form already owns.
  const templateId = form.watch("templateId");
  const template = BRAIN_TEMPLATES.find((t) => t.id === templateId);
  const rootError = form.formState.errors.root;

  const onSubmit = async (values: WorkspaceForm) => {
    const parent = await api.pickFolder();
    // Picker dismissed — not a failure, and not a reason to lose what's typed.
    if (!parent) return;
    const res = await api.createWorkspace(
      parent,
      values.name,
      values.templateId,
    );
    if ("error" in res && res.error) {
      form.setError("root", { message: res.error });
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        // Reset on the way out, so reopening is a clean form rather than the
        // last attempt's values and its error.
        if (!next) form.reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              A workspace is a folder on disk — its own company brain. You'll
              pick where it lives after this.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="ws-name">Company name</FieldLabel>
                  <Input
                    {...field}
                    id="ws-name"
                    placeholder="Acme"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && (
                    <FieldError
                      className="text-[0.6875rem]"
                      errors={[fieldState.error]}
                    />
                  )}
                </Field>
              )}
            />
            <Controller
              name="templateId"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="ws-template">Starting point</FieldLabel>
                  <Select
                    value={field.value}
                    // items lets the trigger render the template NAME; Base
                    // UI's SelectValue shows the raw value otherwise.
                    items={BRAIN_TEMPLATES.map((t) => ({
                      value: t.id,
                      label: t.name,
                    }))}
                    onValueChange={(v) => {
                      if (v) field.onChange(v);
                    }}
                  >
                    <SelectTrigger id="ws-template" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {BRAIN_TEMPLATES.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {template && (
                    <FieldDescription className="text-[0.6875rem]">
                      {template.description}
                    </FieldDescription>
                  )}
                </Field>
              )}
            />
            {rootError?.message && (
              <FieldError className="text-[0.6875rem]">
                {rootError.message}
              </FieldError>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && (
                <Loader2 className="animate-spin" />
              )}
              Choose folder & create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SkillFilter = "all" | "system" | "user" | "off";

/** Skills manager: what this brain can do, one-click runnable, and portable as
 *  skill packs (zip / folder / git URL) — the consultancy delivery unit.
 *  Built for long lists: search + filter chips up top, dense stable-ordered
 *  rows (toggling never reorders), detail + destructive actions in a dialog. */
function SkillsSection() {
  const skills = useStore((s) => s.skills);
  const workspaces = useStore((s) => s.workspaces);
  const active = workspaces.find((w) => w.active);
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  // Detail dialog tracks a name, not a snapshot — the row stays live when the
  // list refreshes (e.g. after the toggle inside the dialog).
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!active)
    return (
      <p className="text-xs text-muted-foreground">No active workspace.</p>
    );

  const doDelete = async (name: string) => {
    setConfirmDelete(false);
    setOpenSkill(null);
    setResult("");
    const res = await api.deleteSkill(active.id, name);
    setResult(res.error ?? `Deleted "${name}" — the folder is in the Trash.`);
    await api.refreshSidebar();
  };

  const doExport = async () => {
    setResult("");
    const dest = await api.pickFolder();
    if (!dest) return;
    const res = await api.exportSkills(active.id, dest);
    setResult(res.error ?? `Exported → ${res.path}`);
  };

  const doImport = async (src: string) => {
    setResult("");
    setImporting(true);
    try {
      const res = await api.importSkills(active.id, src);
      if (res.error) return setResult(res.error);
      setResult(
        `Imported ${res.added.length} skill(s)${res.added.length ? `: ${res.added.join(", ")}` : ""}` +
          (res.skipped.length
            ? ` · skipped (already present): ${res.skipped.join(", ")}`
            : ""),
      );
      setSource("");
      await api.refreshSidebar();
    } finally {
      setImporting(false);
    }
  };

  const q = query.trim().toLowerCase();
  const visible = skills.filter(
    (s) =>
      (!q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)) &&
      (filter === "all" ||
        (filter === "system"
          ? s.system
          : filter === "user"
            ? !s.system
            : !s.enabled)),
  );
  // System skills grouped first and labeled — provenance is visible without
  // splitting the list into tabs (search/chips still span everything).
  const groups = [
    { label: "Built-in", items: visible.filter((s) => s.system) },
    { label: "Your skills", items: visible.filter((s) => !s.system) },
  ].filter((g) => g.items.length > 0);

  const chips: { id: SkillFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: skills.length },
    {
      id: "system",
      label: "Built-in",
      count: skills.filter((s) => s.system).length,
    },
    {
      id: "user",
      label: "Yours",
      count: skills.filter((s) => !s.system).length,
    },
    { id: "off", label: "Off", count: skills.filter((s) => !s.enabled).length },
  ];

  const selected = openSkill
    ? (skills.find((s) => s.name === openSkill) ?? null)
    : null;

  return (
    <section>
      <SectionHeader
        title={`Skills — ${active.name}`}
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void doExport()}
            >
              <Download size={13} /> Export pack…
            </Button>
            <Button
              variant="secondary"
              size="sm"
              title="Pick a skill-pack .zip"
              onClick={() =>
                void api.pickFile().then((p) => {
                  if (p) void doImport(p);
                })
              }
            >
              <Upload size={13} /> Import zip…
            </Button>
          </div>
        }
      >
        Skills are markdown playbooks in the workspace's{" "}
        <span className="font-mono">.claude/skills/</span> — they work in
        terminal Claude Code too. Switch one off and it disappears from the chat
        gallery and the <span className="font-mono">/</span> palette, and the
        agent is refused if it reaches for it anyway. Export them as a pack to
        hand to a client; import packs from a zip, folder, or git repo.
      </SectionHeader>

      <div className="flex gap-2 items-center mb-4">
        <Input
          className="h-8 text-xs font-mono flex-1"
          placeholder="Import from a GitHub / skills.sh URL or folder path…"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={onEnter(() => {
            if (source.trim() && !importing) void doImport(source.trim());
          })}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!source.trim() || importing}
          onClick={() => void doImport(source.trim())}
        >
          {importing ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}{" "}
          Import
        </Button>
      </div>
      {result && <p className="text-xs text-muted-foreground mb-4">{result}</p>}

      {skills.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center mb-4">
          <InputGroup className="h-8 w-56">
            <InputGroupInput
              placeholder="Search skills…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
          {chips.map((c) => (
            <Button
              key={c.id}
              size="xs"
              variant={filter === c.id ? "secondary" : "ghost"}
              className="rounded-full"
              onClick={() => setFilter(c.id)}
            >
              {c.label}
              <span className="text-muted-foreground">{c.count}</span>
            </Button>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="mb-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              {g.label}
            </p>
            <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
              {g.items.map((s) => (
                <div
                  key={s.name}
                  className={cn(
                    "relative flex items-center gap-3 px-3 py-2 hover:bg-muted/50",
                    !s.enabled && "opacity-60",
                  )}
                >
                  {/* Whole row opens the dialog: the button's ::after overlay
                      covers the row's padding too. The Switch sits above the
                      overlay (relative), so toggling never opens the dialog. */}
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left after:absolute after:inset-0"
                    title="Show skill details"
                    onClick={() => {
                      setOpenSkill(s.name);
                      setConfirmDelete(false);
                    }}
                  >
                    <Sparkles
                      size={13}
                      className={cn(
                        "shrink-0",
                        s.enabled ? "text-brand" : "text-muted-foreground",
                      )}
                    />
                    <span className="shrink-0 text-sm font-medium">
                      {s.name}
                    </span>
                    {s.system && (
                      <Badge
                        variant="outline"
                        className="shrink-0 h-4 px-1.5 text-[0.625rem] text-muted-foreground"
                      >
                        built-in
                      </Badge>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">
                      {s.description}
                    </span>
                  </button>
                  <span className="relative flex shrink-0">
                    <Switch
                      checked={s.enabled}
                      title={
                        s.enabled
                          ? "Switch this skill off"
                          : "Switch this skill on"
                      }
                      onCheckedChange={(enabled) =>
                        void api.setSkillEnabled(active.id, s.name, enabled)
                      }
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {skills.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No skills in this workspace.
          </p>
        )}
        {skills.length > 0 && visible.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No skills match{q ? ` “${query.trim()}”` : " this filter"}.
          </p>
        )}
      </div>

      <SkillDetailDialog
        skill={selected}
        workspaceId={active.id}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onClose={() => {
          setOpenSkill(null);
          setConfirmDelete(false);
        }}
        onDelete={(name) => void doDelete(name)}
      />
    </section>
  );
}

/** Frontmatter descriptions arrive as one long trigger-phrase blob, often
 *  wrapped in quotes. Strip the quotes and break at sentence boundaries so
 *  the dialog shows readable paragraphs instead of a wall of text. */
function skillDescriptionParagraphs(description: string): string[] {
  const clean = description
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  return clean
    .split(/(?<=[.!?]['"’”]?)\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function SkillDetailDialog({
  skill,
  workspaceId,
  confirmDelete,
  setConfirmDelete,
  onClose,
  onDelete,
}: {
  skill: SkillInfo | null;
  workspaceId: string;
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  onClose: () => void;
  onDelete: (name: string) => void;
}) {
  return (
    <Dialog open={!!skill} onOpenChange={(open) => !open && onClose()}>
      {skill && (
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles size={14} className="text-brand" />
              {skill.name}
            </DialogTitle>
          </DialogHeader>
          {skill.description && (
            <div className="max-h-60 space-y-2 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
              {skillDescriptionParagraphs(skill.description).map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: This is OK here
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {skill.system && (
              <Badge variant="outline">Built-in — can't be deleted</Badge>
            )}
            {skill.manualOnly && (
              <Badge variant="outline">
                Runs only as <span className="font-mono">/{skill.name}</span>
              </Badge>
            )}
            {!skill.userInvocable && (
              <Badge variant="outline">Agent-triggered only</Badge>
            )}
            {!skill.enabled && <Badge variant="outline">Switched off</Badge>}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-[0.6875rem] text-muted-foreground">
                Off = hidden from the gallery and{" "}
                <span className="font-mono">/</span> palette, denied to the
                agent.
              </p>
            </div>
            <Switch
              checked={skill.enabled}
              onCheckedChange={(enabled) =>
                void api.setSkillEnabled(workspaceId, skill.name, enabled)
              }
            />
          </div>
          <p className="text-[0.6875rem] text-muted-foreground font-mono truncate">
            .claude/skills/…/SKILL.md — edit it in any editor, or ask the agent.
          </p>
          {confirmDelete ? (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs">
              <AlertTriangle size={13} className="shrink-0 text-destructive" />
              <span className="flex-1 text-destructive">
                Delete “{skill.name}”? The folder moves to the Trash.
              </span>
              <Button
                size="xs"
                variant="destructive"
                onClick={() => onDelete(skill.name)}
              >
                Delete
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <DialogFooter>
              {!skill.system && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={13} /> Delete…
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void api.revealSkill(workspaceId, skill.name)}
              >
                <Folder size={13} /> Reveal in Finder
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

const WS_TABS = [
  { id: "sources", label: "Sources" },
  { id: "labels", label: "Labels" },
  { id: "automations", label: "Automations" },
  { id: "access", label: "Access" },
  { id: "usage", label: "Usage" },
] as const;

function WorkspaceCard({ ws }: { ws: WorkspaceInfo }) {
  // In-app confirm: window.confirm is a native panel Electrobun may not show.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The brain you're working in is the one you came here to configure; the
  // others stay one line tall until asked for.
  const [open, setOpen] = useState(ws.active);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "rounded-xl border",
        ws.active ? "border-brand/50" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex items-center rounded-xl transition-colors hover:bg-muted/30",
          open && "rounded-b-none",
        )}
      >
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left rounded-l-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              title={open ? "Hide settings" : "Workspace settings"}
            />
          }
        >
          <Brain
            size={18}
            className={cn(
              "shrink-0",
              ws.active ? "text-brand" : "text-muted-foreground",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="text-sm font-medium">{ws.name}</span>

            <span
              className="block text-[0.6875rem] text-muted-foreground truncate"
              title={ws.path}
            >
              {ws.path}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground">
            {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </CollapsibleTrigger>
        <span className="flex shrink-0 items-center gap-1 pl-2 pr-3">
          {!ws.active && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => void api.setActiveWorkspace(ws.id)}
            >
              Activate
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Workspace actions"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() =>
                  void api.pickFolder().then(async (dest) => {
                    if (dest) await api.exportWorkspace(ws.id, dest);
                  })
                }
              >
                <Download className="size-3" /> Export brain (.zip)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void api.revealActivity(ws.id)}>
                <ScrollText className="size-3" /> Activity log
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* The pair reads as a scale: X takes it off the list, the trash
                  can takes the folder with it. Same icon on both (as it was
                  when Remove stood alone) made them look interchangeable. */}
              <DropdownMenuItem
                variant="destructive"
                className="whitespace-nowrap"
                onClick={() => setConfirmingRemove(true)}
              >
                <X className="size-3" /> Remove
              </DropdownMenuItem>
              {/* Separate item, not a checkbox on Remove: the two differ in
                  what survives, and that is not a detail to bury in a modifier. */}
              <DropdownMenuItem
                variant="destructive"
                className="whitespace-nowrap"
                onClick={() => setDeleting(true)}
              >
                <Trash2 className="size-3" /> Delete folder…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      <DeleteWorkspaceDialog
        ws={ws}
        open={deleting}
        onOpenChange={setDeleting}
      />

      {confirmingRemove && (
        <div className="flex items-center gap-2 border-t border-border bg-destructive/8 px-3 py-2 text-xs last:rounded-b-[calc(var(--radius-xl)-1px)]">
          <AlertTriangle size={13} className="shrink-0 text-destructive" />
          <span className="flex-1 text-destructive">
            Remove “{ws.name}” from Monad? The folder stays on disk.
          </span>
          <Button
            size="xs"
            variant="destructive"
            onClick={() => void api.removeWorkspace(ws.id)}
          >
            Remove
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setConfirmingRemove(false)}
          >
            Cancel
          </Button>
        </div>
      )}

      <CollapsibleContent className="border-t border-border px-4 pt-3 pb-4">
        <Tabs defaultValue="sources">
          <TabsList variant="line" className="mb-1 w-full justify-start gap-4">
            {WS_TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="flex-none text-[0.8125rem]"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="sources">
            <div className="divide-y divide-border/60">
              <GoogleSourceRow ws={ws} />
              <WatchFolderRow ws={ws} />
              <TriggersRow ws={ws} />
            </div>
          </TabsContent>
          <TabsContent value="labels">
            <GmailLabelsTab ws={ws} />
          </TabsContent>
          <TabsContent value="automations">
            <JobsRow ws={ws} />
          </TabsContent>
          <TabsContent value="access">
            <PermissionsRow ws={ws} />
          </TabsContent>
          <TabsContent value="usage">
            <CostRow ws={ws} />
          </TabsContent>
        </Tabs>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One capture source, in the same shape every time: what it is, what it's
 *  doing right now, and the one action you'd reach for — everything rarer
 *  behind the ⋯. */
function SourceRow({
  icon: Icon,
  title,
  detail,
  tone = "muted",
  actions,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: React.ReactNode;
  tone?: "muted" | "success" | "warning" | "destructive";
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const toneClass = {
    muted: "text-muted-foreground",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
  }[tone];
  return (
    <div className="py-3 first:pt-1">
      <div className="flex items-start gap-3">
        <Icon size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[0.8125rem] text-foreground">{title}</p>
          <p className={`text-[0.6875rem] ${toneClass}`}>{detail}</p>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/** Google account (Drive folder sync · Gmail label pull · Calendar) for one workspace. */
function GoogleSourceRow({ ws }: { ws: WorkspaceInfo }) {
  const driveStatus = useStore((s) => s.driveStatus[ws.id]);
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [foldersError, setFoldersError] = useState("");
  const [picked, setPicked] = useState<DriveFolder[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [filter, setFilter] = useState("");

  const connected = !!ws.drive;
  const status = driveStatus?.status;
  const selected = ws.drive?.folders ?? [];
  const gmailLabels = ws.drive?.gmailLabels?.length
    ? ws.drive.gmailLabels
    : [GMAIL_INGEST_LABEL];

  // Seed the picker from what's already synced. Subfolders default on for a
  // first-ever pick and otherwise keep the workspace's current setting — an
  // upgrade must never silently widen what an existing brain pulls.
  const openPicker = async () => {
    setFoldersError("");
    setFilter("");
    setPicked(selected);
    setRecursive(ws.drive?.recursive ?? selected.length === 0);
    const res = await api.driveListFolders(ws.id);
    if (res.error) setFoldersError(res.error);
    setFolders(res.folders);
  };

  const toggle = (f: DriveFolder) =>
    setPicked((prev) =>
      prev.some((p) => p.id === f.id)
        ? prev.filter((p) => p.id !== f.id)
        : [...prev, f],
    );

  const save = async () => {
    await api.driveSetFolders(ws.id, picked, recursive);
    setFolders(null);
  };

  // After OAuth completes, offer the folder picker automatically. `status`
  // flipping to "connected" is the trigger; ws and openPicker are read, not
  // watched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps, see above
  useEffect(() => {
    if (status === "connected" && !ws.drive?.folders?.length) void openPicker();
  }, [status]);

  if (!connected) {
    return (
      <SourceRow
        icon={Cloud}
        title="Google account"
        tone={status === "connecting" ? "warning" : "muted"}
        detail={
          status === "connecting"
            ? "Waiting for browser sign-in…"
            : "Not connected — Drive folder sync, Gmail drafts, Calendar."
        }
        actions={
          status !== "connecting" && (
            <Button
              size="sm"
              variant="secondary"
              title="Grants this workspace: Drive folder sync, Gmail search/read + draft creation (never sends), Calendar read/create"
              onClick={() => void api.driveConnect(ws.id)}
            >
              Connect…
            </Button>
          )
        }
      />
    );
  }

  // Google said the stored grant is dead (the backend already dropped the
  // token). Folders and labels are kept for the reconnect, so say why and
  // offer it — instead of a row that still claims to be connected.
  if (ws.drive?.needsReconnect) {
    return (
      <SourceRow
        icon={Cloud}
        title="Google account"
        tone={status === "connecting" ? "warning" : "destructive"}
        detail={
          status === "connecting"
            ? "Waiting for browser sign-in…"
            : `${ws.drive.email} · ${ws.drive.needsReconnect}`
        }
        actions={
          status !== "connecting" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void api.driveConnect(ws.id)}
              >
                Reconnect…
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Disconnect"
                onClick={() => void api.driveDisconnect(ws.id)}
              >
                <X className="size-4" />
              </Button>
            </>
          )
        }
      />
    );
  }

  const syncing = status === "syncing";
  const failed = status === "error";
  const needle = filter.trim().toLowerCase();
  const visibleFolders = (folders ?? []).filter((f) =>
    f.name.toLowerCase().includes(needle),
  );
  const detail = failed ? (
    (driveStatus?.detail ?? "Sync failed.")
  ) : (
    <>
      <span className="text-success">{ws.drive?.email}</span>
      {" · "}
      {selected.length ? (
        <>
          <span title={selected.map((f) => f.name).join(", ")}>
            {selected.length === 1
              ? selected[0].name
              : `${selected.length} folders`}
          </span>
          {ws.drive?.recursive && " + subfolders"}
          {syncing
            ? " · syncing…"
            : ws.drive?.lastSync
              ? ` · synced ${new Date(ws.drive.lastSync).toLocaleTimeString()}`
              : ""}
        </>
      ) : (
        <span className="text-warning">no Drive folders yet</span>
      )}
      {` · Gmail ${gmailLabels.length === 1 ? "label" : "labels"} ${gmailLabels
        .map((l) => `“${l}”`)
        .join(", ")} → inbox`}
    </>
  );

  return (
    <SourceRow
      icon={Cloud}
      title="Google account"
      tone={failed ? "destructive" : "muted"}
      detail={detail}
      actions={
        <>
          {selected.length > 0 && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Sync now"
              disabled={syncing}
              onClick={() => void api.driveSync(ws.id)}
            >
              {syncing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" title="Google actions" />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => void openPicker()}>
                <Folder className="size-3" />{" "}
                {selected.length
                  ? "Change Drive folders"
                  : "Choose Drive folders"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void api.driveDisconnect(ws.id)}
              >
                <X className="size-3" /> Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      {foldersError && (
        <FieldError className="ml-[27px] mt-1 text-[0.6875rem]">
          {foldersError}
        </FieldError>
      )}
      {folders && (
        <div className="ml-[27px] mt-2 rounded-lg border border-border">
          {/* Drive returns every folder in the account as one flat, unnested
              list, so picking several out of it needs a filter to be usable. */}
          <div className="border-b border-border p-1.5">
            <Input
              className="h-7 text-[0.6875rem]"
              placeholder="Filter folders…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="max-h-40 divide-y divide-border overflow-y-auto">
            {visibleFolders.length === 0 && (
              <p className="p-2 text-[0.6875rem] text-muted-foreground">
                {folders.length === 0
                  ? "No folders found in this Drive."
                  : "No folders match that filter."}
              </p>
            )}
            {visibleFolders.map((f) => {
              const on = picked.some((p) => p.id === f.id);
              return (
                <button
                  type="button"
                  key={f.id}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-muted"
                  onClick={() => toggle(f)}
                >
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border",
                    )}
                  >
                    {on && <Check size={9} strokeWidth={3} />}
                  </span>
                  <Folder size={11} className="shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 border-t border-border p-2">
            <Switch
              id={`drive-recursive-${ws.id}`}
              checked={recursive}
              onCheckedChange={setRecursive}
            />
            <Label
              htmlFor={`drive-recursive-${ws.id}`}
              className="text-[0.6875rem] font-normal text-muted-foreground"
            >
              Include subfolders
            </Label>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setFolders(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()}>
              {picked.length
                ? `Sync ${picked.length} folder${picked.length > 1 ? "s" : ""}`
                : "Stop syncing"}
            </Button>
          </div>
        </div>
      )}
    </SourceRow>
  );
}

/** Gmail trigger labels: an email carrying any of them is pulled into inbox/
 *  on the next sync. Chips for the active set, suggestions from the account's
 *  real label list, free text for a label that doesn't exist in Gmail yet. */
function GmailLabelsTab({ ws }: { ws: WorkspaceInfo }) {
  const [available, setAvailable] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);

  const email = ws.drive?.email;
  const isDefault = !ws.drive?.gmailLabels?.length;
  const active = isDefault
    ? [GMAIL_INGEST_LABEL]
    : (ws.drive?.gmailLabels ?? []);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    void api.gmailListLabels(ws.id).then((res) => {
      if (cancelled) return;
      if (res.error) setError(res.error);
      setAvailable(res.labels);
    });
    return () => {
      cancelled = true;
    };
  }, [ws.id, email]);

  if (!email) {
    return (
      <p className="pt-2 text-xs text-muted-foreground">
        Connect a Google account under Sources first — then any Gmail label you
        pick here routes labeled emails into this brain.
      </p>
    );
  }

  const set = async (labels: string[]) => {
    setSaving(true);
    try {
      await api.driveSetGmailLabels(ws.id, labels);
    } finally {
      setSaving(false);
    }
  };
  const add = (name: string) => {
    const n = name.trim();
    if (!n || active.some((l) => l.toLowerCase() === n.toLowerCase())) return;
    void set([...active, n]);
  };
  const remove = (name: string) => void set(active.filter((l) => l !== name));

  const suggestions = (available ?? []).filter(
    (l) => !active.some((a) => a.toLowerCase() === l.toLowerCase()),
  );

  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-muted-foreground">
        Apply any of these labels to an email in {email} and it lands in inbox/
        on the next sync.
        {isDefault && " Using the default label — add your own to customize."}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {active.map((l) => (
          <span
            key={l}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs"
          >
            <Tag size={11} className="text-muted-foreground" />
            {l}
            {!isDefault && (
              <button
                type="button"
                title="Stop pulling emails with this label"
                disabled={saving}
                className="ml-0.5 rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => remove(l)}
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="h-7 max-w-56 text-[0.6875rem]"
          placeholder="Add a label… e.g. Receipts"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              add(custom);
              setCustom("");
            }
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!custom.trim() || saving}
          onClick={() => {
            add(custom);
            setCustom("");
          }}
        >
          <Plus size={13} /> Add
        </Button>
      </div>
      {error && <FieldError className="text-[0.6875rem]">{error}</FieldError>}
      {suggestions.length > 0 && (
        <div>
          <p className="mb-1 text-[0.6875rem] text-muted-foreground">
            Labels in this Gmail account:
          </p>
          <div className="flex flex-wrap gap-1">
            {suggestions.map((l) => (
              <button
                type="button"
                key={l}
                disabled={saving}
                className="rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => add(l)}
              >
                + {l}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Zero-OAuth capture path: a local folder mirrored into inbox/ every minute. */
function WatchFolderRow({ ws }: { ws: WorkspaceInfo }) {
  const [error, setError] = useState("");
  const choose = async () => {
    setError("");
    const picked = await api.pickFolder();
    if (!picked) return;
    const res = await api.setWatchFolder(ws.id, picked);
    if (!res.ok && res.error) setError(res.error);
  };

  return (
    <SourceRow
      icon={FolderPlus}
      title="Watch folder"
      tone={error ? "destructive" : "muted"}
      detail={
        error ||
        (ws.watchFolder ? (
          <span className="truncate" title={ws.watchFolder}>
            {ws.watchFolder} — new files are copied to the inbox
          </span>
        ) : (
          "Not set — anything saved to a watched folder lands in the inbox."
        ))
      }
      actions={
        ws.watchFolder ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Watch folder actions"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void choose()}>
                <Folder className="size-3" /> Change folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void api.setWatchFolder(ws.id, undefined)}
              >
                <X className="size-3" /> Stop watching
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            title="Pick a local folder (e.g. ~/Desktop/for-monad); anything saved there is copied into the inbox and ingested"
            onClick={() => void choose()}
          >
            Choose…
          </Button>
        )
      }
    />
  );
}

/** What does this brain cost to run? Aggregated from per-run results; the soft
 *  budget feeds the health banner rather than blocking anything. */
function CostRow({ ws }: { ws: WorkspaceInfo }) {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [budget, setBudget] = useState(
    ws.budgetUsd ? String(ws.budgetUsd) : "",
  );

  useEffect(() => {
    void api.costSummary(ws.id).then(setSummary);
  }, [ws.id]);

  const saveBudget = async () => {
    const value = parseFloat(budget);
    await api.setBudget(
      ws.id,
      Number.isFinite(value) && value > 0 ? value : undefined,
    );
  };

  if (!summary) return null;
  const over = ws.budgetUsd && summary.thisMonthUsd > ws.budgetUsd;
  return (
    <div className="pt-1 space-y-4">
      <div>
        <p
          className={cn(
            "text-2xl font-semibold tabular-nums",
            over ? "text-warning" : "text-foreground",
          )}
        >
          ${summary.thisMonthUsd.toFixed(2)}
        </p>
        <p className="text-[0.6875rem] text-muted-foreground">
          this month · {summary.runsThisMonth} run
          {summary.runsThisMonth === 1 ? "" : "s"} · last month $
          {summary.lastMonthUsd.toFixed(2)} · all time $
          {summary.allTimeUsd.toFixed(2)}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={`budget-${ws.id}`}>
          Soft monthly budget
        </Label>
        <div className="flex items-center gap-2">
          <InputGroup className="w-32">
            <InputGroupInput
              id={`budget-${ws.id}`}
              placeholder="None"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              onBlur={() => void saveBudget()}
              onKeyDown={onEnter(() => void saveBudget())}
            />
            <InputGroupAddon>
              <DollarSign />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">
          Overruns surface in the health banner — nothing is blocked.
        </p>
      </div>
    </div>
  );
}

/** Event triggers: new inbox file matching X → fold an extra instruction into
 *  the ingest run (e.g. "*.vtt → draft follow-ups from the transcript"). */
function TriggersRow({ ws }: { ws: WorkspaceInfo }) {
  const [adding, setAdding] = useState(false);
  const [match, setMatch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");

  const add = async () => {
    setError("");
    const res = await api.addInboxTrigger(ws.id, match, prompt);
    if (!res.ok) return setError(res.error ?? "Could not add the trigger.");
    setMatch("");
    setPrompt("");
    setAdding(false);
  };

  return (
    <SourceRow
      icon={Zap}
      title="Inbox triggers"
      tone={error ? "destructive" : "muted"}
      detail={
        error ||
        (ws.inboxTriggers.length === 0
          ? "None — e.g. *.vtt → “draft follow-up emails for the action items”."
          : `${ws.inboxTriggers.length} rule${ws.inboxTriggers.length === 1 ? "" : "s"} — an extra instruction rides the ingest run when a file matches.`)
      }
      actions={
        !adding && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Add trigger"
            onClick={() => setAdding(true)}
          >
            <Plus size={15} />
          </Button>
        )
      }
    >
      {ws.inboxTriggers.length > 0 && (
        <div className="ml-[27px] mt-2 space-y-1">
          {ws.inboxTriggers.map((t) => (
            <div key={t.id} className="group flex items-center gap-2 text-xs">
              <span className="font-mono bg-muted rounded px-1.5 py-0.5 text-[0.6875rem] shrink-0">
                {t.match}
              </span>
              <span
                className="text-muted-foreground truncate flex-1"
                title={t.prompt}
              >
                {t.prompt}
              </span>
              <button
                type="button"
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                title="Remove trigger"
                onClick={() => void api.removeInboxTrigger(ws.id, t.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <div className="ml-[27px] mt-2 flex items-center gap-2">
          <Input
            className="h-7 w-28 text-[0.6875rem] font-mono"
            placeholder="*.vtt or acme"
            value={match}
            onChange={(e) => setMatch(e.target.value)}
          />
          <Input
            className="h-7 flex-1 text-[0.6875rem]"
            placeholder="extra instruction for the ingest run"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onEnter(() => void add())}
          />
          <Button size="sm" onClick={() => void add()}>
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}
    </SourceRow>
  );
}

function PermissionsRow({ ws }: { ws: WorkspaceInfo }) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [adding, setAdding] = useState("");

  // Which MCP connectors are installed here decides the connector options we
  // can offer; the built-in "google" server isn't in .mcp.json so it's added
  // separately when a Google account is connected.
  useEffect(() => {
    void api.mcpList(ws.id).then((r) => setServers(r.servers));
  }, [ws.id]);

  const options = useMemo(() => {
    const opts: ToolOption[] = [
      ...BUILTIN_TOOL_OPTIONS,
      ...(ws.drive ? GOOGLE_TOOL_OPTIONS : []),
      ...servers.map((s) => connectorToolOption(s.name)),
    ];
    // Keep any current rule we don't recognize (hand-typed) selectable as a chip.
    const known = new Set(opts.map((o) => o.rule));
    for (const rule of ws.alwaysAllow) {
      if (!known.has(rule)) {
        opts.push(customToolOption(rule));
        known.add(rule);
      }
    }
    return opts;
  }, [ws.drive, ws.alwaysAllow, servers]);

  const setRules = (rules: string[]) => void api.setAlwaysAllow(ws.id, rules);

  const addCustom = () => {
    const rule = adding.trim();
    if (!rule || ws.alwaysAllow.includes(rule)) return setAdding("");
    setRules([...ws.alwaysAllow, rule]);
    setAdding("");
  };

  return (
    <div className="pt-1">
      <p className="text-[0.8125rem] text-foreground">Always-allowed tools</p>
      <p className="text-[0.6875rem] text-muted-foreground mb-2">
        These run without asking. Everything else still needs a click.
      </p>
      <ToolPicker
        options={options}
        value={ws.alwaysAllow}
        onChange={setRules}
      />
      <button
        type="button"
        className="mt-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
        onClick={() => setAdvanced((a) => !a)}
      >
        {advanced ? "Hide" : "Advanced:"} add a custom rule
      </button>
      {advanced && (
        <div className="flex items-center gap-2 mt-1.5">
          <Input
            className="h-6 rounded-md px-2 py-0 text-[0.6875rem] font-mono flex-1 bg-background"
            placeholder="e.g. mcp__twenty__*  (a `*` suffix matches every tool from a connector)"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={onEnter(addCustom)}
          />
          <Button size="xs" variant="secondary" onClick={addCustom}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/** The last day the job really ran. A job added after its time carries a
 *  same-day lastRunDate stamp (so it waits for its next occurrence) — that
 *  stamp is not a run and must not read as one. */
function lastRunLabel(j: ScheduledJob): string | undefined {
  if (j.lastSuccessDate) return j.lastSuccessDate;
  if (j.lastRunDate && j.lastRunDate !== j.addedDate) return j.lastRunDate;
  return undefined;
}

/** "next Mon 08:00" / "next today 08:00" / "due now" — so a weekday-only job
 *  on a weekend, or one just added, visibly says when it will fire. */
function nextRunLabel(j: ScheduledJob): string | null {
  const now = new Date();
  const next = nextJobRun(j, now);
  if (!next) return null;
  if (next <= now) return "due now";
  const time = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  const days = Math.round(
    (new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  const day =
    days === 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : next.toLocaleDateString(undefined, { weekday: "short" });
  return `next ${day} ${time}`;
}
const JOB_PRESETS = [
  {
    label: "Morning briefing (Mon–Fri 8:00)",
    job: {
      name: "Morning briefing",
      prompt: "Run the morning-briefing skill and produce today's briefing.",
      hour: 8,
      minute: 0,
      days: [1, 2, 3, 4, 5],
      enabled: true,
    },
  },
  {
    label: "Weekly CRM status (Mon 9:00)",
    job: {
      name: "Weekly CRM status",
      prompt:
        "Run the crm-status skill: full pipeline report and follow-up drafts for pending items.",
      hour: 9,
      minute: 0,
      days: [1],
      enabled: true,
    },
  },
];

function JobsRow({ ws }: { ws: WorkspaceInfo }) {
  const runState = useStore((s) => s.runState);
  // "Run now" streams into the OPEN thread, so only that thread being busy
  // blocks it — background runs and parallel threads don't.
  const busy = runState === "running";
  const [customOpen, setCustomOpen] = useState(false);

  const unusedPresets = JOB_PRESETS.filter(
    (p) => !ws.jobs.some((j) => j.name === p.job.name),
  );

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <p className="text-[0.8125rem] text-foreground">Scheduled runs</p>
          <p className="text-[0.6875rem] text-muted-foreground">
            They catch up after sleep and may use always-allowed tools only.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="secondary"
                title="Add a scheduled run"
              />
            }
          >
            <Plus size={13} /> Add
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {unusedPresets.map((p) => (
              <DropdownMenuItem
                key={p.label}
                onClick={() => void api.addJob(ws.id, p.job)}
              >
                {p.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => setCustomOpen(true)}>
              Custom…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-2 space-y-1">
        {ws.jobs.map((j) => (
          <Fragment key={j.id}>
            <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/50">
              <Switch
                size="sm"
                checked={j.enabled}
                onCheckedChange={() => void api.toggleJob(ws.id, j.id)}
                title={j.enabled ? "Disable" : "Enable"}
              />
              <span
                className={
                  j.enabled ? "text-foreground" : "text-muted-foreground"
                }
              >
                {j.name}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {String(j.hour).padStart(2, "0")}:
                {String(j.minute).padStart(2, "0")}{" "}
                {j.days.map((d) => DAY_LABELS[d]).join("")}
              </span>
              {lastRunLabel(j) && (
                <span className="text-muted-foreground/70">
                  last {lastRunLabel(j)}
                </span>
              )}
              {nextRunLabel(j) && (
                <span className="text-muted-foreground/70">
                  {nextRunLabel(j)}
                </span>
              )}
              <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title={
                    busy
                      ? "The open thread is busy — switch to an idle one first"
                      : "Run now (streams into the chat)"
                  }
                  disabled={busy}
                  onClick={() => {
                    useStore.getState().setSettingsOpen(false);
                    void api.startRun(j.prompt);
                  }}
                >
                  <Play size={12} />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Remove this run"
                  className="hover:text-destructive"
                  onClick={() => void api.removeJob(ws.id, j.id)}
                >
                  <X size={12} />
                </Button>
              </span>
            </div>
            {jobKind(j) === "briefing" && (
              <div className="ml-9 flex items-center gap-2.5 px-2 pb-1 text-xs">
                <Switch
                  size="sm"
                  checked={ws.briefingFocus !== false}
                  onCheckedChange={(v) => void api.setBriefingFocus(ws.id, v)}
                  title="Toggle the Suggested focus section"
                />
                <span className="text-muted-foreground">
                  Suggested focus — top 3 recommended actions in the briefing
                </span>
              </div>
            )}
          </Fragment>
        ))}
        {ws.jobs.length === 0 && !customOpen && (
          <p className="text-[0.6875rem] text-muted-foreground">
            Nothing scheduled.
          </p>
        )}
      </div>
      {customOpen && (
        <CustomJobForm
          ws={ws}
          onCancel={() => setCustomOpen(false)}
          onAdded={() => setCustomOpen(false)}
        />
      )}
      <div className="mt-4 flex items-start gap-2.5 border-t border-border/60 pt-3">
        <Switch
          size="sm"
          className="mt-0.5"
          checked={!!ws.meetingPrep}
          onCheckedChange={(v) => void api.setMeetingPrep(ws.id, v)}
        />
        <div>
          <p className="text-[0.8125rem] text-foreground">Meeting prep</p>
          <p className="text-[0.6875rem] text-muted-foreground">
            Drafts a brief ~1h before calendar events. Needs Google.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A scheduled run the user writes themselves. The time field is the reason
 *  this form has a schema: "08:00" is four ways to get it wrong, and the error
 *  belongs on that input rather than in a footnote under the buttons. */
const DAY_SETS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  monday: [1],
};

const jobSchema = z.object({
  name: z.string().trim().min(1, "Give the run a name."),
  time: z
    .string()
    .trim()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, e.g. 08:00."),
  days: z.enum(["daily", "weekdays", "monday"]),
  prompt: z.string().trim().min(1, "Say what the run should do."),
});

type JobForm = z.infer<typeof jobSchema>;

function CustomJobForm({
  ws,
  onCancel,
  onAdded,
}: {
  ws: WorkspaceInfo;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const form = useForm<JobForm>({
    resolver: zodResolver(jobSchema),
    defaultValues: { name: "", time: "08:00", days: "weekdays", prompt: "" },
  });

  const onSubmit = async (values: JobForm) => {
    const [hour, minute] = values.time.split(":").map(Number);
    await api.addJob(ws.id, {
      name: values.name,
      prompt: values.prompt,
      hour,
      minute,
      days: DAY_SETS[values.days],
      enabled: true,
    });
    onAdded();
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup className="mt-3 rounded-xl border border-border p-4">
        <div className="flex gap-3">
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="flex-1">
                <FieldLabel htmlFor="job-name">Name</FieldLabel>
                <Input
                  {...field}
                  id="job-name"
                  placeholder="Morning briefing"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && (
                  <FieldError
                    className="text-[0.6875rem]"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />
          <Controller
            name="time"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="w-24">
                <FieldLabel htmlFor="job-time">Time</FieldLabel>
                <Input
                  {...field}
                  id="job-time"
                  className="font-mono"
                  placeholder="08:00"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && (
                  <FieldError
                    className="text-[0.6875rem]"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />
          <Controller
            name="days"
            control={form.control}
            render={({ field }) => (
              <Field className="w-36">
                <FieldLabel htmlFor="job-days">Days</FieldLabel>
                <Select
                  value={field.value}
                  // items lets the trigger render the label; Base UI's
                  // SelectValue shows the raw value otherwise.
                  items={{
                    daily: "Every day",
                    weekdays: "Weekdays",
                    monday: "Mondays",
                  }}
                  onValueChange={(v) => {
                    if (v) field.onChange(v as JobForm["days"]);
                  }}
                >
                  <SelectTrigger id="job-days" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="daily">Every day</SelectItem>
                      <SelectItem value="weekdays">Weekdays</SelectItem>
                      <SelectItem value="monday">Mondays</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
        </div>
        <Controller
          name="prompt"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="job-prompt">Prompt</FieldLabel>
              <Input
                {...field}
                id="job-prompt"
                placeholder="Use the watch-metric skill: alert if weekly signups drop below 100."
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && (
                <FieldError
                  className="text-[0.6875rem]"
                  errors={[fieldState.error]}
                />
              )}
            </Field>
          )}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            type="submit"
            disabled={form.formState.isSubmitting}
          >
            Add run
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** Providers: every auth mode is switched on or off independently, and each
 *  enabled one contributes its models to the composer's picker. One of them is
 *  the default — the provider background runs (ingest, scheduled jobs) use. */
function ProvidersSection() {
  const settings = useStore((s) => s.settings);
  const ollama = useStore((s) => s.ollama);
  const [expanded, setExpanded] = useState<ProviderId | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  // Re-probe everything a row can show: the Claude and Codex CLI paths
  // (memoized on the bun side until recheck clears them), the Keychain keys,
  // and Ollama's server.
  const recheck = async () => {
    setChecking(true);
    await Promise.all([api.getSettings(true), api.refreshOllama()]);
    setCheckedAt(
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
    setChecking(false);
  };

  // The Ollama row needs live status even when local mode isn't the default.
  useEffect(() => {
    void api.refreshOllama();
  }, []);

  if (!settings) return null;

  const setEnabled = (id: ProviderId, enabled: boolean) => {
    const next = enabled
      ? [...settings.enabledProviders, id]
      : settings.enabledProviders.filter((p) => p !== id);
    void api.updateSettings({ enabledProviders: next });
    if (enabled && id === "local-ollama") void api.refreshOllama();
  };

  return (
    <section>
      <SectionHeader
        title="Providers"
        action={
          <div className="flex items-center gap-2">
            {checkedAt && !checking && (
              <span className="text-[0.6875rem] text-muted-foreground">
                Checked {checkedAt}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Re-check providers"
              disabled={checking}
              onClick={() => void recheck()}
            >
              <RefreshCw size={14} className={cn(checking && "animate-spin")} />
            </Button>
          </div>
        }
      >
        Switch on the providers you want available. Every enabled provider's
        models show up in the chat model picker, and picking a model there also
        picks the provider that serves it. The{" "}
        <span className="text-foreground">default</span> provider is the one
        background work uses — ingest, scheduled jobs and meeting prep.
      </SectionHeader>
      <div className="space-y-8">
        {PROVIDER_VENDORS.map((vendor) => {
          const VendorIcon = vendor.icon;
          return (
            <div key={vendor.id}>
              <div className="mb-3 flex items-start gap-2.5">
                <VendorIcon size={16} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">{vendor.title}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5 max-w-[62ch]">
                    {vendor.blurb}
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {PROVIDERS.filter((meta) => meta.vendor === vendor.id).map(
                  (meta) => (
                    <ProviderRow
                      key={meta.id}
                      meta={meta}
                      settings={settings}
                      health={providerHealth(meta.id, settings, ollama)}
                      expanded={expanded === meta.id}
                      onOpenChange={(open) =>
                        setExpanded(open ? meta.id : null)
                      }
                      onSetEnabled={(enabled) => setEnabled(meta.id, enabled)}
                    />
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const HEALTH_DOT: Record<ProviderHealth["state"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
};

function ProviderRow({
  meta,
  settings,
  health,
  expanded,
  onOpenChange,
  onSetEnabled,
}: {
  meta: ProviderMeta;
  settings: SettingsView;
  health: ProviderHealth;
  expanded: boolean;
  onOpenChange: (open: boolean) => void;
  onSetEnabled: (enabled: boolean) => void;
}) {
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const enabled = settings.enabledProviders.includes(meta.id);
  const isDefault = settings.authMode === meta.id;
  // Only Claude-runtime providers can take background work (see AuthMode).
  const canBeDefault = AUTH_MODES.includes(meta.id as AuthMode);
  const Icon = meta.icon;
  // The default provider can't be switched off from under itself — make
  // another one the default first (that hands the role over explicitly).
  const lockedOn = isDefault && settings.enabledProviders.length === 1;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={onOpenChange}
      className="rounded-xl border border-border"
    >
      {/* The whole header opens the panel — the toggle sits outside the
          trigger so flipping a provider on never expands it as a side effect. */}
      <div
        className={cn(
          "flex items-center rounded-xl transition-colors hover:bg-muted/40",
          expanded && "rounded-b-none",
        )}
      >
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left rounded-l-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              title={expanded ? "Hide settings" : "Provider settings"}
            />
          }
        >
          <span className="relative shrink-0">
            <Icon
              size={18}
              className={cn(
                enabled ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <span
              className={`absolute -top-1 -left-1 size-2 rounded-full ${HEALTH_DOT[health.state]}`}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium">{meta.rowTitle}</span>
              {isDefault && (
                <span className="text-[0.625rem] rounded-sm px-1.5 py-0.5 bg-brand/15 text-brand">
                  default
                </span>
              )}
              {meta.experimental && (
                <span className="text-[0.625rem] rounded-sm px-1.5 py-0.5 bg-warning/15 text-warning">
                  experimental
                </span>
              )}
            </span>
            <span
              className="block text-[0.6875rem] text-muted-foreground truncate"
              title={health.detail}
            >
              {health.detail}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground">
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </CollapsibleTrigger>
        <span className="flex items-center pl-3 pr-4">
          <Switch
            checked={enabled}
            disabled={lockedOn}
            title={
              lockedOn
                ? "The only enabled provider — make another one the default first"
                : enabled
                  ? "Switch this provider off"
                  : "Switch this provider on"
            }
            onCheckedChange={onSetEnabled}
          />
        </span>
      </div>
      <CollapsibleContent className="border-t border-border p-4 space-y-3">
        <p className="text-xs text-muted-foreground">{meta.blurb}</p>
        {meta.id === "subscription-cli" && (
          <ClaudeCliSettings settings={settings} />
        )}
        {meta.id === "api-key" && (
          <ApiKeyField
            id="anthropic-key"
            label="Anthropic API key"
            placeholder="sk-ant-…"
            hasKey={settings.hasApiKey}
            onSave={(key) => api.updateSettings({ apiKey: key })}
          />
        )}
        {meta.id === "openai-subscription" && (
          <CodexCliSettings settings={settings} />
        )}
        {meta.id === "openai-api-key" && (
          <ApiKeyField
            id="openai-key"
            label="OpenAI API key"
            placeholder="sk-…"
            hasKey={settings.hasOpenAIApiKey}
            onSave={(key) => api.updateSettings({ openaiApiKey: key })}
          />
        )}
        {meta.id === "local-ollama" && <LocalModelsPanel />}
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void api.testAuth(meta.id).then(setTest)}
          >
            Test connection
          </Button>
          {!isDefault && canBeDefault && (
            <Button
              variant="ghost"
              size="sm"
              title="Use this provider for background runs (ingest, scheduled jobs)"
              onClick={() =>
                void api.updateSettings({ authMode: meta.id as AuthMode })
              }
            >
              Make default
            </Button>
          )}
          {test && (
            <span
              className={cn(
                "text-xs",
                test.ok ? "text-success" : "text-destructive",
              )}
            >
              {test.message}
            </span>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ClaudeCliSettings({ settings }: { settings: SettingsView }) {
  const [path, setPath] = useState<string | null>(null);
  const value = path ?? settings.claudeBinaryPath;

  return (
    <>
      <ClaudeAccountField key={settings.resolvedClaudePath} />
      <Field>
        <FieldLabel htmlFor="claude-binary">Binary path</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="claude-binary"
            className="flex-1 h-8 text-xs font-mono"
            placeholder={settings.resolvedClaudePath || "claude"}
            value={value}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={path === null}
            onClick={() => {
              void api.updateSettings({
                claudeBinaryPath: (path ?? "").trim(),
              });
              setPath(null);
            }}
          >
            Save
          </Button>
        </div>
        <FieldDescription className="text-[0.6875rem]">
          Leave empty to auto-detect. Found:{" "}
          <span className="font-mono">
            {settings.resolvedClaudePath || "nothing"}
          </span>
        </FieldDescription>
      </Field>
    </>
  );
}

/** Who the Claude Code CLI is signed in as, with the in-app sign-in. The
 *  status is what `claude auth status` says; a token that exists but can
 *  no longer refresh only shows up when a run fails (that path offers the
 *  same sign-in inline in the chat). */
function ClaudeAccountField() {
  const status = useStore((s) => s.claudeAuth);
  const [showFlow, setShowFlow] = useState(false);

  useEffect(() => {
    void api.claudeAuthStatus();
  }, []);

  const label = !status
    ? "Checking…"
    : status.loggedIn
      ? `Signed in${status.email ? ` as ${status.email}` : ""}${status.method ? ` (${status.method})` : ""}`
      : status.error
        ? `Not available — ${status.error.slice(0, 120)}`
        : "Not signed in";

  return (
    <Field>
      <FieldLabel>Account</FieldLabel>
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={cn(
            "text-xs",
            status && !status.loggedIn
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {!showFlow && status && (
          <Button
            size="sm"
            variant={status.loggedIn ? "secondary" : "default"}
            onClick={() => setShowFlow(true)}
          >
            {status.loggedIn ? "Sign in again" : "Sign in"}
          </Button>
        )}
      </div>
      {showFlow && (
        <div className="pt-1">
          <ClaudeLoginFlow
            autoStart
            onSignedIn={() => {
              void api.claudeAuthStatus();
              setShowFlow(false);
            }}
          />
        </div>
      )}
      <FieldDescription className="text-[0.6875rem]">
        Monad rides your Claude Code login. When a chat ends with "Failed to
        authenticate", sign in again here or from the card in the chat.
      </FieldDescription>
    </Field>
  );
}

/** Write-only API key entry: the key goes straight to the Keychain and is
 *  never read back into the webview — only whether one is stored. */
function ApiKeyField({
  id,
  label,
  placeholder,
  hasKey,
  onSave,
}: {
  id: string;
  label: string;
  placeholder: string;
  hasKey: boolean;
  onSave: (key: string) => Promise<unknown>;
}) {
  const [apiKey, setApiKey] = useState("");

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          type="password"
          className="flex-1 h-8 text-xs font-mono"
          placeholder={hasKey ? "Replace API key…" : placeholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!apiKey.trim()}
          onClick={() => {
            void onSave(apiKey.trim());
            setApiKey("");
          }}
        >
          Save key
        </Button>
      </div>
      <FieldDescription className="text-[0.6875rem]">
        {hasKey ? (
          <>
            Stored in the macOS Keychain{" "}
            <Check size={11} className="inline -mt-px" />
          </>
        ) : (
          "Stored in the macOS Keychain — never written to disk in plain text."
        )}
      </FieldDescription>
    </Field>
  );
}

function CodexCliSettings({ settings }: { settings: SettingsView }) {
  const [path, setPath] = useState<string | null>(null);
  const value = path ?? settings.codexBinaryPath;

  return (
    <>
      <CodexAccountField key={settings.resolvedCodexPath} />
      <Field>
        <FieldLabel htmlFor="codex-binary">Binary path</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="codex-binary"
            className="flex-1 h-8 text-xs font-mono"
            placeholder={settings.resolvedCodexPath || "codex"}
            value={value}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={path === null}
            onClick={() => {
              void api.updateSettings({
                codexBinaryPath: (path ?? "").trim(),
              });
              setPath(null);
            }}
          >
            Save
          </Button>
        </div>
        <FieldDescription className="text-[0.6875rem]">
          Leave empty to auto-detect. Found:{" "}
          <span className="font-mono">
            {settings.resolvedCodexPath || "nothing"}
          </span>
        </FieldDescription>
      </Field>
    </>
  );
}

/** How the Codex CLI is signed in, with the in-app sign-in: `codex login`
 *  opens the ChatGPT page in the browser and finishes on its own. */
function CodexAccountField() {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api.codexAuthStatus().then(setStatus);
  }, []);

  const signIn = async () => {
    setSigningIn(true);
    setError("");
    const res = await api.codexLogin();
    setStatus(res.status);
    if (!res.ok) setError(res.error ?? "Sign-in didn't complete.");
    setSigningIn(false);
  };

  const label = !status
    ? "Checking…"
    : status.loggedIn
      ? `Signed in${status.method ? ` with ${status.method}` : ""}`
      : status.error
        ? `Not available — ${status.error.slice(0, 120)}`
        : "Not signed in";

  // Signed in with ChatGPT is the finished state — nothing to do, so no
  // button. An API-key login can switch over to the ChatGPT plan; signed out
  // gets the sign-in.
  const onChatGPT = !!status?.loggedIn && status.method === "ChatGPT";
  const action =
    !status || status.error || onChatGPT
      ? null
      : status.loggedIn
        ? "Use ChatGPT instead"
        : "Sign in with ChatGPT";

  return (
    <Field>
      <FieldLabel>Account</FieldLabel>
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            status && !status.loggedIn
              ? "text-destructive"
              : status?.loggedIn
                ? "text-success"
                : "text-muted-foreground",
          )}
        >
          {status?.loggedIn && !signingIn && <Check size={13} />}
          {signingIn ? "Finish signing in in your browser…" : label}
        </span>
        {action && (
          <Button
            size="sm"
            variant={status?.loggedIn ? "secondary" : "default"}
            disabled={signingIn}
            onClick={() => void signIn()}
          >
            {action}
          </Button>
        )}
      </div>
      {error && <FieldError>{error}</FieldError>}
      <FieldDescription className="text-[0.6875rem]">
        {onChatGPT
          ? "Monad rides your Codex login — runs bill to your ChatGPT plan."
          : status?.loggedIn
            ? "Codex is signed in with an API key, so runs bill to that key rather than your ChatGPT plan."
            : "Monad rides your Codex login — runs bill to your ChatGPT plan."}
      </FieldDescription>
    </Field>
  );
}

const FIT_BADGE: Record<LocalModelFit, { label: string; cls: string }> = {
  good: { label: "runs well", cls: "text-success bg-success/15" },
  tight: { label: "tight fit", cls: "text-warning bg-warning/15" },
  "too-big": { label: "too big", cls: "text-destructive bg-destructive/15" },
};

function FitBadge({ fit, hint }: { fit: LocalModelFit; hint: string }) {
  return (
    <span
      className={`text-[0.625rem] px-1.5 py-0.5 rounded-md whitespace-nowrap ${FIT_BADGE[fit].cls}`}
      title={hint}
    >
      {FIT_BADGE[fit].label}
    </span>
  );
}

/** The whole local-model journey in one panel: install Ollama → start it →
 *  download a recommended model (RAM-fit-checked for THIS Mac) → pick the
 *  default. Zero terminal. */
function LocalModelsPanel() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.ollama);
  const pulls = useStore((s) => s.pulls);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");

  useEffect(() => {
    void api.refreshOllama();
  }, []);

  if (!settings) return null;
  if (!status) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 size={12} className="animate-spin" /> Checking for Ollama…
      </div>
    );
  }

  const start = async () => {
    setStarting(true);
    setStartError("");
    const res = await api.ollamaStart();
    if (!res.ok) setStartError(res.error ?? "Couldn't start Ollama.");
    setStarting(false);
  };

  if (!status.installed) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Local mode needs <span className="text-foreground">Ollama</span> — a
          free, open-source model server that runs entirely on this Mac.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => void api.openUrl("https://ollama.com/download/mac")}
          >
            <Download size={12} className="mr-1" /> Get Ollama
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void api.refreshOllama()}
          >
            I've installed it — check again
          </Button>
        </div>
      </div>
    );
  }

  if (!status.running) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Ollama is installed but not running.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? (
              <Loader2 size={12} className="mr-1 animate-spin" />
            ) : (
              <Play size={12} className="mr-1" />
            )}
            Start Ollama
          </Button>
          {startError && (
            <FieldError className="text-xs">{startError}</FieldError>
          )}
        </div>
      </div>
    );
  }

  const toDownload = status.recommended.filter((r) => !r.installed);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        This Mac:{" "}
        <span className="text-foreground">
          {status.totalRamGb} GB unified memory
        </span>{" "}
        — fit checks below are for this machine.
      </p>

      {status.models.length > 0 && (
        <div>
          <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground mb-1.5">
            Installed models
          </p>
          <div className="space-y-1">
            {status.models.map((m) => {
              const isDefault = m.id === settings.localModel;
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5"
                >
                  <Cpu size={12} className="text-success shrink-0" />
                  <span className="text-xs text-foreground truncate">
                    {m.id}
                  </span>
                  <span className="text-[0.625rem] text-muted-foreground shrink-0">
                    {m.sizeGb} GB{m.paramSize ? ` · ${m.paramSize}` : ""}
                  </span>
                  <FitBadge fit={m.fit} hint={m.fitHint} />
                  <div className="flex-1" />
                  {isDefault ? (
                    <span className="text-[0.625rem] text-brand shrink-0">
                      default <Check size={10} className="inline -mt-px" />
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-6 text-[0.625rem] px-2"
                      onClick={() =>
                        void api.updateSettings({ localModel: m.id })
                      }
                    >
                      Use as default
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {status.models.length === 0 && (
        <p className="text-xs text-warning/90">
          No models installed yet — download one below to finish setup.
        </p>
      )}

      {toDownload.length > 0 && (
        <div>
          <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground mb-1.5">
            Recommended for this Mac
          </p>
          <div className="space-y-1">
            {toDownload.map((r) => {
              const pull = pulls[r.id];
              return (
                <div
                  key={r.id}
                  className="rounded-lg bg-muted/50 px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-foreground">{r.label}</span>
                    <FitBadge fit={r.fit} hint={r.fitHint} />
                    <div className="flex-1" />
                    <span className="text-[0.625rem] text-muted-foreground shrink-0">
                      ~{r.downloadGb} GB · needs {r.minRamGb} GB RAM
                    </span>
                    {pull && !pull.error ? (
                      <span className="text-[0.625rem] text-brand shrink-0 w-24 text-right">
                        {pull.percent !== undefined
                          ? `${pull.percent}%`
                          : pull.status}
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-6 text-[0.625rem] px-2"
                        disabled={r.fit === "too-big"}
                        title={r.fit === "too-big" ? r.fitHint : undefined}
                        onClick={() => void api.ollamaPull(r.id)}
                      >
                        <Download size={10} className="mr-1" /> Download
                      </Button>
                    )}
                  </div>
                  <div className="text-[0.6875rem] text-muted-foreground mt-0.5">
                    {r.blurb}
                  </div>
                  {pull && !pull.error && pull.percent !== undefined && (
                    <div className="mt-1.5 h-1 rounded bg-muted overflow-hidden">
                      <div
                        className="h-full bg-brand transition-[width] duration-200 ease-out"
                        style={{ width: `${pull.percent}%` }}
                      />
                    </div>
                  )}
                  {pull?.error && (
                    <FieldError className="mt-1 text-[0.6875rem]">
                      {pull.error}
                    </FieldError>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">
        Tip: local models shine at background work (ingest, summaries). For
        briefings and CRM drafting, Claude is still the better writer — switch
        modes any time.
      </p>
    </div>
  );
}

function GoogleClientSection() {
  const settings = useStore((s) => s.settings);
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [advanced, setAdvanced] = useState(false);

  if (!settings) return null;
  const idValue = clientId ?? settings.googleClientId;
  // Without a built-in client the override IS the setup, so it starts open —
  // but the section around it always stays put, so there's a way back.
  const open = advanced || !settings.googleClientBuiltIn;

  return (
    <section>
      <SectionHeader title="Google">
        This app is registered with Google so workspaces can connect accounts —{" "}
        <span className="text-foreground">
          no account is connected by itself
        </span>
        , and nothing is shared with your Claude login. Each workspace
        authorizes its own Google account (Drive · Gmail · Calendar) from the{" "}
        <span className="text-foreground">Workspaces</span> section; its tokens
        stay in your macOS Keychain and are removed on disconnect.
      </SectionHeader>
      <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground mb-1.5">
        Connections
      </p>
      <div className="space-y-1 mb-6">
        <GoogleConnectionList />
      </div>

      <Collapsible
        open={open}
        // A build with no client of its own has nothing to collapse to — the
        // override IS the setup there, so the row stays open and inert.
        onOpenChange={(next) =>
          settings.googleClientBuiltIn && setAdvanced(next)
        }
        className="rounded-xl border border-border"
      >
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-3 p-3 text-left rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                open && "rounded-b-none",
                settings.googleClientBuiltIn
                  ? "hover:bg-muted/40"
                  : "cursor-default",
              )}
              title={
                settings.googleClientBuiltIn
                  ? open
                    ? "Hide the client override"
                    : "Override the built-in client"
                  : undefined
              }
            />
          }
        >
          <Cloud size={16} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">OAuth client</span>
            <span className="block text-[0.6875rem] text-muted-foreground truncate">
              {settings.googleClientBuiltIn
                ? "Built into this build — nothing to do here."
                : "Developer setup — this build ships no client."}
            </span>
          </span>
          {settings.googleClientBuiltIn && (
            <span className="shrink-0 text-muted-foreground">
              {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border p-4">
          <FieldGroup>
            <p className="text-xs text-muted-foreground">
              {settings.googleClientBuiltIn
                ? "Advanced: override the built-in client (development/testing). Leave both fields empty and Save to fall back to the built-in one."
                : "Bring your own Google client: in Google Cloud Console enable the Drive, Gmail and Calendar APIs, then create an OAuth client of type 'Desktop app' and paste its ID and secret here. On Google Workspace, choose the 'Internal' audience and nobody sees an unverified-app warning. Full walkthrough: docs/google-oauth.html in the Monad repo."}
            </p>
            <Field>
              <FieldLabel htmlFor="google-client-id">Client ID</FieldLabel>
              <Input
                id="google-client-id"
                className="w-full h-8 text-xs font-mono"
                placeholder="…apps.googleusercontent.com"
                value={idValue}
                onChange={(e) => setClientId(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="google-client-secret">
                Client secret
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="google-client-secret"
                  type="password"
                  className="flex-1 h-8 text-xs font-mono"
                  placeholder={
                    settings.hasGoogleClientSecret
                      ? "Replace secret…"
                      : "GOCSPX-…"
                  }
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void api.updateSettings({
                      ...(clientId !== null
                        ? { googleClientId: clientId.trim() }
                        : {}),
                      ...(secret.trim()
                        ? { googleClientSecret: secret.trim() }
                        : {}),
                    });
                    setSecret("");
                    setClientId(null);
                  }}
                >
                  Save
                </Button>
              </div>
              <FieldDescription className="text-[0.6875rem]">
                {settings.hasGoogleClientSecret && settings.googleClientId ? (
                  <span className="text-success">
                    Google client configured{" "}
                    <Check size={11} className="inline -mt-px" />
                  </span>
                ) : (
                  "Stored in your macOS Keychain."
                )}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** Knowledge graph: one workspace at a time, picked explicitly — each
 *  workspace's graph is built from its own knowledge/ and index alone. */
function KnowledgeGraphSection() {
  const workspaces = useStore((s) => s.workspaces);
  const active = workspaces.find((w) => w.active);
  const [wsId, setWsId] = useState(active?.id ?? "");

  return (
    <section>
      <SectionHeader title="Knowledge graph">
        The people, companies and projects in a workspace's brain, and the docs
        that connect them. Built from the markdown in{" "}
        <span className="font-mono">knowledge/</span> — frontmatter{" "}
        <span className="font-mono">entities:</span>,{" "}
        <span className="font-mono">[[wikilinks]]</span> and entity pages — so
        it is always rebuildable, and never shared between workspaces.
      </SectionHeader>

      <Field className="mb-6 max-w-xs">
        <FieldLabel htmlFor="graph-workspace">Workspace</FieldLabel>
        <Select
          value={wsId || null}
          // items lets the trigger render the workspace NAME: Base UI's
          // SelectValue shows the raw value (the id) otherwise.
          items={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          onValueChange={(v) => setWsId(v ?? "")}
        >
          <SelectTrigger id="graph-workspace">
            <SelectValue placeholder="Choose workspace" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {/* Keyed by workspace: switching remounts the view, so selection,
          search and layout never carry over from another workspace. */}
      {wsId && (
        <Suspense
          fallback={
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
            </div>
          }
        >
          <KnowledgeGraphView key={wsId} workspaceId={wsId} />
        </Suspense>
      )}
    </section>
  );
}

function ConnectorsSection() {
  const workspaces = useStore((s) => s.workspaces);
  const active = workspaces.find((w) => w.active);
  const [wsId, setWsId] = useState(active?.id ?? "");
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  // In-app confirm (name of the connector pending removal); no native dialogs.
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const ws = workspaces.find((w) => w.id === wsId);

  const reload = async (id: string) => {
    if (!id) return;
    const res = await api.mcpList(id);
    setServers(res.servers);
    setTestResults({});
  };

  // reload is rebuilt every render and takes wsId as an argument — watching it
  // would re-fetch the connector list on every render. The workspace changing
  // is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps, see above
  useEffect(() => {
    void reload(wsId);
  }, [wsId]);

  return (
    <section>
      <SectionHeader title="Connectors">
        MCP servers give the agent tools — CRM, analytics, anything. They live
        in the workspace's <span className="font-mono">.mcp.json</span>, so they
        work from terminal Claude Code too, and no connector from another app
        ever leaks in.
      </SectionHeader>

      <Field className="mb-6 max-w-xs">
        <FieldLabel htmlFor="connectors-workspace">Workspace</FieldLabel>
        <Select
          value={wsId || null}
          // items lets the trigger render the workspace NAME: Base UI's
          // SelectValue shows the raw value (the id) otherwise.
          items={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          onValueChange={(v) => setWsId(v ?? "")}
        >
          <SelectTrigger id="connectors-workspace">
            <SelectValue placeholder="Choose workspace" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <div className="space-y-3">
        {servers.map((srv) => (
          <Collapsible
            key={srv.name}
            // Closed by default; a connector still missing credentials opens
            // so the amber fields the catalog copy promises are visible.
            defaultOpen={srv.envVars.some((v) => v.source === "missing")}
            className="rounded-xl border border-border"
          >
            <div className="flex items-center gap-3 p-3">
              <ConnectorIcon
                id={srv.name}
                size={16}
                fallback={Plug}
                className="shrink-0 text-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium capitalize">
                    {srv.name}
                  </span>
                  <Badge variant="secondary">{srv.kind}</Badge>
                </div>
                <p
                  className="text-[0.6875rem] text-muted-foreground font-mono truncate"
                  title={srv.detail}
                >
                  {srv.detail}
                </p>
                {testResults[srv.name] && (
                  <p
                    className={cn(
                      "text-[0.6875rem] mt-1",
                      testResults[srv.name].ok
                        ? "text-success"
                        : "text-destructive",
                    )}
                  >
                    {testResults[srv.name].message}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {srv.envVars.length > 0 && (
                  <CollapsibleTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="group"
                        title={`${srv.envVars.length} credential${srv.envVars.length === 1 ? "" : "s"}`}
                      />
                    }
                  >
                    <ChevronDown
                      size={15}
                      className="transition-[rotate] duration-150 ease-out motion-reduce:transition-none group-data-panel-open:rotate-180"
                    />
                  </CollapsibleTrigger>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  title="Start the server and list its tools"
                  onClick={() =>
                    void api
                      .mcpTest(wsId, srv.name)
                      .then((r) =>
                        setTestResults((t) => ({ ...t, [srv.name]: r })),
                      )
                  }
                >
                  Test
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Connector actions"
                      />
                    }
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setConfirmingRemove(srv.name)}
                    >
                      <Trash2 className="size-3" /> Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {confirmingRemove === srv.name && (
              <div className="flex items-center gap-2 border-t border-border bg-destructive/8 px-3 py-2 text-xs last:rounded-b-[calc(var(--radius-xl)-1px)]">
                <AlertTriangle
                  size={13}
                  className="shrink-0 text-destructive"
                />
                <span className="flex-1 text-destructive">
                  Remove “{srv.name}” from this workspace?
                </span>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setConfirmingRemove(null);
                    void api.mcpRemove(wsId, srv.name).then(() => reload(wsId));
                  }}
                >
                  Remove
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setConfirmingRemove(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
            {srv.envVars.length > 0 && (
              <CollapsibleContent>
                <FieldGroup className="border-t border-border p-4">
                  {srv.envVars.map((v) => (
                    <CredentialField
                      key={v.name}
                      wsId={wsId}
                      envVar={v}
                      onChanged={() => void reload(wsId)}
                    />
                  ))}
                </FieldGroup>
              </CollapsibleContent>
            )}
          </Collapsible>
        ))}
        {ws?.drive && (
          <div className="flex items-center gap-3 rounded-xl border border-border/60 p-3 opacity-80">
            <Cloud className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Google</span>
                <Badge
                  variant="secondary"
                  className="text-[0.625rem] uppercase"
                >
                  built-in
                </Badge>
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                Gmail · Calendar · Drive for {ws.drive.email} — managed in
                Workspaces.
              </p>
            </div>
          </div>
        )}
        {servers.length === 0 && !ws?.drive && (
          <p className="text-xs text-muted-foreground">
            No connectors in this workspace yet — add one below.
          </p>
        )}
      </div>

      <div className="mt-8">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-foreground">Add a connector</p>
            <p className="text-[0.6875rem] text-muted-foreground">
              One click installs it; any credentials it needs appear as amber
              fields above.
            </p>
          </div>
          {!adding && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAdding(true)}
            >
              <Plus size={13} /> Custom…
            </Button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {CONNECTOR_CATALOG.filter(
            (c) => !servers.some((s) => s.name === c.server.name),
          ).map((c) => (
            <button
              type="button"
              key={c.id}
              className="rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
              title={`${c.description}${c.note ? ` — ${c.note}` : ""}`}
              onClick={() =>
                void api.mcpAdd(wsId, c.server).then((r) => {
                  if (!r.ok) setError(r.error ?? "Failed to add connector.");
                  else void reload(wsId);
                })
              }
            >
              <span className="block text-[0.75rem] text-foreground font-medium">
                <ConnectorIcon
                  id={c.id}
                  className="inline -mt-px mr-1.5 text-foreground"
                />
                {c.name}
              </span>
              <span className="block text-[0.625rem] text-muted-foreground line-clamp-2">
                {c.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      {adding && (
        <CustomConnectorForm
          wsId={wsId}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void reload(wsId);
          }}
        />
      )}
      {error && <FieldError className="mt-3 text-xs">{error}</FieldError>}
    </section>
  );
}

/** A hand-configured MCP server. The only form here with conditional, per-field
 *  rules (URL vs command, by transport), so it's the one that earns a schema
 *  and react-hook-form instead of a bag of useState. */
const connectorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give the connector a name.")
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Letters, numbers, - and _ only."),
    kind: z.enum(["http", "stdio"]),
    url: z.string().trim(),
    bearerEnvVar: z.string().trim(),
    command: z.string().trim(),
    envLines: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "http") {
      if (!v.url)
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "A server URL is required.",
        });
      else if (!/^https?:\/\//i.test(v.url))
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Must start with http:// or https://.",
        });
    } else if (!v.command) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "A command is required.",
      });
    }
  });

type ConnectorForm = z.infer<typeof connectorSchema>;

function CustomConnectorForm({
  wsId,
  onCancel,
  onAdded,
}: {
  wsId: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const form = useForm<ConnectorForm>({
    resolver: zodResolver(connectorSchema),
    defaultValues: {
      name: "",
      kind: "http",
      url: "",
      bearerEnvVar: "",
      command: "",
      envLines: "",
    },
  });
  const kind = form.watch("kind");
  const rootError = form.formState.errors.root?.message;

  const onSubmit = async (values: ConnectorForm) => {
    const res = await api.mcpAdd(wsId, values);
    // The bun side owns the real rules (duplicate names, unparseable env) —
    // its rejection lands on the form itself rather than in a stray banner.
    if (!res.ok)
      return form.setError("root", {
        message: res.error ?? "Failed to add connector.",
      });
    onAdded();
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup className="mt-6 rounded-xl border border-border p-4">
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
              <Input
                {...field}
                id="mcp-name"
                className="font-mono"
                placeholder="linear"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid ? (
                <FieldError
                  className="text-[0.6875rem]"
                  errors={[fieldState.error]}
                />
              ) : (
                <FieldDescription className="text-[0.6875rem]">
                  How the agent's tools are prefixed —{" "}
                  <span className="font-mono">mcp__linear__*</span>.
                </FieldDescription>
              )}
            </Field>
          )}
        />
        <Controller
          name="kind"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel>Transport</FieldLabel>
              <RadioGroup
                value={field.value}
                onValueChange={(v) =>
                  field.onChange(v as ConnectorForm["kind"])
                }
                className="flex gap-4"
              >
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value="http" id="mcp-http" />
                  <Label
                    htmlFor="mcp-http"
                    className="text-xs font-normal cursor-pointer"
                  >
                    Remote (HTTP)
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value="stdio" id="mcp-stdio" />
                  <Label
                    htmlFor="mcp-stdio"
                    className="text-xs font-normal cursor-pointer"
                  >
                    Local (command)
                  </Label>
                </div>
              </RadioGroup>
            </Field>
          )}
        />
        {kind === "http" ? (
          <>
            <Controller
              name="url"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="mcp-url">Server URL</FieldLabel>
                  <Input
                    {...field}
                    id="mcp-url"
                    className="font-mono"
                    placeholder="https://mcp.example.com/mcp"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && (
                    <FieldError
                      className="text-[0.6875rem]"
                      errors={[fieldState.error]}
                    />
                  )}
                </Field>
              )}
            />
            <Controller
              name="bearerEnvVar"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="mcp-bearer">Auth env var</FieldLabel>
                  <Input
                    {...field}
                    id="mcp-bearer"
                    className="font-mono"
                    placeholder="LINEAR_API_KEY"
                  />
                  <FieldDescription className="text-[0.6875rem]">
                    Optional — its value is sent as a Bearer token.
                  </FieldDescription>
                </Field>
              )}
            />
          </>
        ) : (
          <>
            <Controller
              name="command"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
                  <Input
                    {...field}
                    id="mcp-command"
                    className="font-mono"
                    placeholder="npx -y some-mcp-server"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && (
                    <FieldError
                      className="text-[0.6875rem]"
                      errors={[fieldState.error]}
                    />
                  )}
                </Field>
              )}
            />
            <Controller
              name="envLines"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="mcp-env">Environment</FieldLabel>
                  <Textarea
                    {...field}
                    id="mcp-env"
                    className="text-xs font-mono min-h-[52px]"
                    placeholder={"API_KEY=${MY_API_KEY}"}
                  />
                  <FieldDescription className="text-[0.6875rem]">
                    One per line. Values may reference the workspace's .env.
                  </FieldDescription>
                </Field>
              )}
            />
          </>
        )}
        <FieldDescription className="text-[0.6875rem]">
          Keep secrets out of this form — put them in the workspace's{" "}
          <span className="font-mono">.env</span> and reference them as{" "}
          <span className="font-mono">{"${VAR_NAME}"}</span>. Takes effect on
          the next message.
        </FieldDescription>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            type="submit"
            disabled={form.formState.isSubmitting}
          >
            Add connector
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {rootError && (
          <FieldError className="text-[0.6875rem]">{rootError}</FieldError>
        )}
      </FieldGroup>
    </form>
  );
}

/** One credential an installed connector needs: where its value comes from,
 *  and the one control that changes it. */
function CredentialField({
  wsId,
  envVar,
  onChanged,
}: {
  wsId: string;
  envVar: { name: string; source: "app" | "env-file" | "missing" };
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    const res = await api.wsEnvSet(wsId, envVar.name, value);
    if (!res.ok) return setError(res.error ?? "Failed to save.");
    setValue("");
    setEditing(false);
    onChanged();
  };

  const inputId = `env-${wsId}-${envVar.name}`;
  const showInput = envVar.source === "missing" || editing;

  return (
    <Field data-invalid={!!error || undefined}>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor={inputId} className="font-mono text-xs">
          {envVar.name}
        </FieldLabel>
        {envVar.source === "missing" && (
          <span className="flex items-center gap-1 text-[0.6875rem] text-warning">
            <AlertTriangle size={11} /> needed
          </span>
        )}
        {envVar.source === "app" && (
          <span className="flex items-center gap-1 text-[0.6875rem] text-success">
            <Check size={11} /> saved
          </span>
        )}
        {envVar.source === "env-file" && (
          <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
            <Check size={11} /> from .env
          </span>
        )}
        <span className="flex-1" />
        {envVar.source === "app" && !editing && (
          <>
            <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="hover:text-destructive"
              onClick={() =>
                void api.wsEnvClear(wsId, envVar.name).then(onChanged)
              }
            >
              Clear
            </Button>
          </>
        )}
        {envVar.source === "env-file" && !editing && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Override
          </Button>
        )}
      </div>
      {showInput && (
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="password"
            className="flex-1 h-8 text-xs font-mono"
            placeholder="Paste value"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setEditing(true);
            }}
            onKeyDown={onEnter(() => {
              if (value.trim()) void save();
            })}
          />
          <Button
            size="sm"
            disabled={!value.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
          {editing && envVar.source !== "missing" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
      <FieldDescription className="text-[0.6875rem]">
        {envVar.source === "env-file"
          ? "Comes from the workspace's .env (developer setup). An override is stored in your macOS Keychain."
          : "Stored in your macOS Keychain — never written to the workspace."}
      </FieldDescription>
      <FieldError className="text-[0.6875rem]">{error || undefined}</FieldError>
    </Field>
  );
}

/** Per-workspace Google connection status — makes it obvious nothing connects itself. */
function GoogleConnectionList() {
  const workspaces = useStore((s) => s.workspaces);
  if (workspaces.length === 0)
    return <p className="text-xs text-muted-foreground">No workspaces yet.</p>;
  return (
    <>
      {workspaces.map((w) => (
        <div key={w.id} className="flex items-center gap-2 text-xs">
          <Brain size={12} className="text-muted-foreground" />
          <span className="text-foreground">{w.name}</span>
          {w.drive ? (
            <span className="text-success flex items-center gap-1">
              <Check size={11} /> {w.drive.email}
            </span>
          ) : (
            <span className="text-muted-foreground">not connected</span>
          )}
        </div>
      ))}
    </>
  );
}

/** Troubleshooting: the same two actions as the Help menu, where a colleague
 *  told "Settings → Troubleshooting → Export" can find them. */
function TroubleshootingSection() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    path?: string;
    error?: string;
  } | null>(null);

  const runExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      setResult(await api.exportDiagnostics());
    } catch (e) {
      setResult({ ok: false, error: String((e as Error)?.message ?? e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <SectionHeader title="Troubleshooting">
        When something didn't happen the way it should — a briefing that never
        ran, a sync that stalled — export diagnostics and send the file to
        whoever is helping you. Also in the menu bar under Help.
      </SectionHeader>

      <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
        <div className="flex items-center gap-3 px-3 py-3">
          <FileArchive size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              Export diagnostics
            </span>
            <span className="block text-[0.6875rem] text-muted-foreground">
              A zip on your Desktop: app log, scheduled-job state and the last
              14 days of workspace activity. No keys, tokens, chats or
              documents.
            </span>
          </span>
          <Button
            size="sm"
            disabled={exporting}
            onClick={() => void runExport()}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            Export
          </Button>
        </div>
        <div className="flex items-center gap-3 px-3 py-3">
          <ScrollText size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">App log</span>
            <span className="block text-[0.6875rem] text-muted-foreground">
              What the app did behind the scenes, in ~/Library/Logs/Monad.
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void api.revealLogs()}
          >
            <Folder /> Open folder
          </Button>
        </div>
      </div>

      {result?.ok && result.path && (
        <p className="mt-3 text-xs text-muted-foreground">
          <Check size={12} className="inline mr-1 text-brand" />
          Saved{" "}
          <span className="text-foreground">
            {result.path.split("/").pop()}
          </span>{" "}
          — it's selected in Finder.
        </p>
      )}
      {result && !result.ok && (
        <FieldError className="mt-3 text-xs">
          Couldn't export diagnostics: {result.error}
        </FieldError>
      )}
    </section>
  );
}

function UpdatesFooter() {
  const settings = useStore((s) => s.settings);
  if (!settings) return null;

  return (
    <div className="px-3 pb-2 space-y-1.5">
      <UpdateControls />
      <p className="text-[0.625rem] text-muted-foreground">
        Monad v{settings.appVersion}
        {settings.channel && settings.channel !== "stable"
          ? ` · ${settings.channel}`
          : ""}
      </p>
    </div>
  );
}
