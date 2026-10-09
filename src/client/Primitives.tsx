import { CheckCheck, Layers3 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
export function Modal({
  title,
  busy,
  close,
  children,
}: {
  title: string;
  busy: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="mw-modal-backdrop"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      {children}
    </dialog>
  );
}
export function CopyDraft({ text }: { text: string }) {
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    setFeedback("");
  }, [text]);
  return (
    <button
      className="mw-text-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setFeedback("已复制");
        } catch {
          setFeedback("复制失败，请手动选择文本");
        }
      }}
    >
      <CheckCheck size={14} />
      {feedback || "复制草稿"}
    </button>
  );
}
export function Tag({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`mw-tag ${tone}`}>{children}</span>;
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="mw-empty">
      <Layers3 size={30} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: number;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="mw-stat">
      <div>
        <span>{label}</span>
        <span className="mw-stat-icon">{icon}</span>
      </div>
      <strong>
        {value}
        <span>项</span>
      </strong>
      <p>{sub}</p>
    </div>
  );
}
