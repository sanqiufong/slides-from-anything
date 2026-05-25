import { useEffect, useRef, useState } from 'react';

import { fetchVaultDiscovery, type VaultDiscoveryInfo, type VaultDiscoveryState } from '../providers/registry';
import { Icon } from './Icon';

interface Props {
  /** Called once when discovery reports the vault is running. */
  onReady: (info: VaultDiscoveryInfo) => void;
  onClose: () => void;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export function DesignVaultInstallGate({ onReady, onClose }: Props) {
  const [info, setInfo] = useState<VaultDiscoveryInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<'clone' | 'run' | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const readyDispatchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const next = await fetchVaultDiscovery();
      if (cancelled) return;
      setInfo(next);
      setLoading(false);
      if (next && next.state === 'running' && !readyDispatchedRef.current) {
        readyDispatchedRef.current = true;
        onReady(next);
      }
    }

    void poll();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
        window.clearInterval(timer);
        return;
      }
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onReady]);

  function copy(kind: 'clone' | 'run', value: string) {
    if (!value) return;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(kind);
        window.setTimeout(() => setCopied(null), 1600);
      });
    } else {
      window.prompt('请手动复制：', value);
    }
  }

  const state: VaultDiscoveryState = info?.state ?? 'not-installed';
  const headline = headlineFor(state, loading);
  const body = bodyFor(state);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal vault-install-gate" onClick={(event) => event.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <span className="vault-kicker">Design Vault</span>
            <h2 style={{ marginTop: 6 }}>{headline}</h2>
            <p className="hint" style={{ marginTop: 6 }}>{body}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </header>

        {state === 'not-installed' ? (
          <CommandBlock
            label="① 安装并启动 Design Vault"
            command={info?.install.cloneCmd ?? 'git clone <git-clone-url> ~/project/design-vault && cd ~/project/design-vault && pnpm install && pnpm dev'}
            copied={copied === 'clone'}
            onCopy={(value) => copy('clone', value)}
          />
        ) : null}

        {state === 'installed-not-running' ? (
          <CommandBlock
            label="启动命令"
            command={info?.install.runCmd ?? 'cd ~/project/design-vault && pnpm dev'}
            copied={copied === 'run'}
            onCopy={(value) => copy('run', value)}
          />
        ) : null}

        {state === 'configured-not-reachable' ? (
          <div className="vault-install-warning" style={{ marginTop: 10, lineHeight: 1.55 }}>
            已配置 <code>OPENPPT_VAULT_ORIGIN</code> 但无法连通：检查 design-vault 进程是否在运行，或者临时取消此环境变量改用注册表自动发现。
            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>注册表路径：<code>{info?.registryPath}</code></div>
          </div>
        ) : null}

        <div className="vault-install-status" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span
            aria-hidden
            className={`vault-status-dot ${state === 'running' ? 'ready' : 'embedded'}`}
            style={{ display: 'inline-block' }}
          />
          <span>{statusFooter(state, loading)}</span>
        </div>

        {info?.lastSeen ? (
          <div style={{ marginTop: 6, opacity: 0.6, fontSize: 11 }}>
            上次检测到：{new Date(info.lastSeen).toLocaleString()}
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={state !== 'running'}
            onClick={() => info && onReady(info)}
          >
            {state === 'running' ? '继续' : '等待 Design Vault 启动...'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CommandBlock({
  label,
  command,
  copied,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="vault-install-command" style={{ marginTop: 14 }}>
      <div className="vault-kicker" style={{ marginBottom: 6 }}>{label}</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--surface-muted, #111)',
          borderRadius: 6,
          padding: '10px 12px',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <code style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{command}</code>
        <button type="button" className="ghost" onClick={() => onCopy(command)} aria-label="复制命令">
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          <span style={{ marginLeft: 4 }}>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
    </div>
  );
}

function headlineFor(state: VaultDiscoveryState, loading: boolean): string {
  if (loading) return '正在检测 Design Vault...';
  switch (state) {
    case 'running':
      return 'Design Vault 已就绪';
    case 'installed-not-running':
      return 'Design Vault 已安装但未启动';
    case 'configured-not-reachable':
      return '已配置 Design Vault 但无法连通';
    case 'not-installed':
    default:
      return '未检测到 Design Vault';
  }
}

function bodyFor(state: VaultDiscoveryState): string {
  switch (state) {
    case 'running':
      return '将带你前往 Design Vault 完成模板新增，完成后会自动返回这里。';
    case 'installed-not-running':
      return '在终端启动 dev server，下方状态会在 2 秒内自动刷新。';
    case 'configured-not-reachable':
      return '当前的 OPENPPT_VAULT_ORIGIN 指向的服务没有响应。';
    case 'not-installed':
    default:
      return '复制下方命令安装并启动 Design Vault（独立项目，与 SFA 互不依赖）。';
  }
}

function statusFooter(state: VaultDiscoveryState, loading: boolean): string {
  if (loading) return '检测中...';
  if (state === 'running') return '已连接 · 准备跳转';
  return '正在每 2 秒检测一次...';
}
