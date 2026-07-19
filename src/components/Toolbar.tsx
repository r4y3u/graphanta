import { TOOL_LABELS } from '../defaults';
import type { ToolId } from '../types';
import { Icon } from './Icon';

interface ToolbarProps {
  tools: ToolId[];
  activeTool: ToolId;
  onChange: (tool: ToolId) => void;
}

export function Toolbar({ tools, activeTool, onChange }: ToolbarProps) {
  return (
    <aside className="toolbar" aria-label="作図ツール">
      {tools.map((tool) => {
        const disabled = tool === 'function';
        return (
          <button
            key={tool}
            className={`tool-button ${activeTool === tool ? 'is-active' : ''}`}
            type="button"
            title={TOOL_LABELS[tool]}
            aria-label={TOOL_LABELS[tool]}
            disabled={disabled}
            onClick={() => onChange(tool)}
          >
            <Icon name={tool} />
            {disabled && <span className="tool-badge">v3</span>}
          </button>
        );
      })}
    </aside>
  );
}
