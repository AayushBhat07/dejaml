import type { RunEvent } from "@dejaml/contracts";

const KIND_LABELS: Record<RunEvent["evidence"][number]["kind"], string> = {
  paper_page: "Paper",
  repository_file: "Code",
  log_line: "Log",
  artifact: "Artifact",
};

export function EvidenceList({ evidence }: { evidence: RunEvent["evidence"] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="evidence" aria-label="Evidence">
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${item.reference}:${index}`} className="evidence-item">
          <span className="evidence-kind">{KIND_LABELS[item.kind]}</span>
          <span className="mono evidence-ref">{item.reference}</span>
          {item.excerpt ? <q className="evidence-excerpt">{item.excerpt}</q> : null}
        </li>
      ))}
    </ul>
  );
}
