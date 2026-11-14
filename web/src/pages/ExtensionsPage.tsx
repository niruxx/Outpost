import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Layout, PageHeader } from '../components/Layout.js';
import { Card, ErrorText, Select } from '../components/ui.js';
type Extension = {
    id: string;
    name: string;
    version: string;
    pages: {
        id: string;
        title: string;
        permissions: string[];
    }[];
};
interface Page {
    title: string;
    html: string;
    extension: {
        id: string;
        version: string;
    };
    actions: {
        id: string;
        title: string;
        permissions: string[];
    }[];
}
export function ExtensionsPage() {
    const params = useParams(), [search, setSearch] = useSearchParams(), serverId = search.get('serverId') ?? '', frame = useRef<HTMLIFrameElement>(null);
    const [extensions, setExtensions] = useState<Extension[]>([]), [servers, setServers] = useState<{
        id: string;
        name: string;
    }[]>([]), [page, setPage] = useState<Page | null>(null), [error, setError] = useState('');
    useEffect(() => {
        let current = true;
        api.get<{
            extensions: Extension[];
        }>('/extensions').then(r => current && setExtensions(r.extensions)).catch(e => current && setError(e.message));
        api.get<{
            servers: typeof servers;
        }>('/servers').then(r => current && setServers(r.servers)).catch(() => { });
        return () => { current = false; };
    }, []);
    useEffect(() => {
        setPage(null);
        setError('');
        if (!params.extensionId || !params.pageId)
            return;
        let current = true;
        api.get<Page>(`/extensions/${params.extensionId}/pages/${params.pageId}${serverId ? '?serverId=' + encodeURIComponent(serverId) : ''}`).then(r => current && setPage(r)).catch(e => current && setError(e.message));
        return () => { current = false; };
    }, [params.extensionId, params.pageId, serverId]);
    useEffect(() => {
        let active = 0;
        const listener = async (event: MessageEvent) => {
            const sender = frame.current?.contentWindow, data = event.data;
            if (!page || !sender || event.source !== sender || data?.type !== 'outpost.extension.invoke' || data.sdkVersion !== 1 || typeof data.requestId !== 'string' || data.requestId.length > 100)
                return;
            const reply = (payload: object) => {
                if (frame.current?.contentWindow === sender)
                    sender.postMessage({ type: 'outpost.extension.response', sdkVersion: 1, requestId: data.requestId, ...payload }, '*');
            };
            if (active >= 8 || !page.actions.some(a => a.id === data.action)) {
                reply({ error: 'Action is unavailable or too many requests are pending' });
                return;
            }
            active++;
            try {
                const result = await api.post(`/extensions/${page.extension.id}/actions/${encodeURIComponent(data.action)}${serverId ? '?serverId=' + encodeURIComponent(serverId) : ''}`, { input: data.input });
                reply({ result });
            }
            catch (e) {
                reply({ error: (e as Error).message });
            }
            finally {
                active--;
            }
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }, [page, serverId]);
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`;
    return <Layout><div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-8"><PageHeader title="Extensions" subtitle="Enabled pages run in a sandbox and use permission-checked Outpost actions."/><label className="block text-sm">Instance context<Select aria-label="Extension instance context" value={serverId} onChange={e => setSearch(e.target.value ? { serverId: e.target.value } : {})}><option value="">Global administrator context</option>{servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label><ErrorText>{error}</ErrorText>
    {page ? <Card className="space-y-3 p-4"><h2 className="text-lg">{page.title} · {page.extension.version}</h2><iframe key={`${page.extension.id}:${params.pageId}:${serverId}`} ref={frame} title={`${page.title} extension`} className="min-h-[32rem] w-full rounded border border-surface-700 bg-white" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={csp + page.html}/></Card> : !params.pageId && !extensions.length ? <Card className="p-6">No extensions are enabled. An administrator can review/install them under Configuration → Operations → Extension SDK.</Card> : null}
    <div className="grid gap-3 sm:grid-cols-2">{extensions.map(e => <Card key={e.id} className="space-y-2 p-4"><h2>{e.name} · {e.version}</h2>{e.pages.map(p => <Link key={p.id} className="block text-accent-400 underline" to={`/extensions/${e.id}/${p.id}${serverId ? '?serverId=' + encodeURIComponent(serverId) : ''}`}>{p.title}<span className="ml-2 text-xs text-ink-400">{p.permissions.join(', ') || 'Administrator only'}</span></Link>)}</Card>)}</div>
  </div></Layout>;
}
