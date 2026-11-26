import Link from 'next/link'
export default function P(){return <main><h1>home</h1>
<ul>
<li><Link href="/a/contacts/123" id="a1">A contact 123</Link></li>
<li><Link href="/a/x/khach/v/kanban1" id="a2">A view</Link></li>
<li><Link href="/a/s/cua-hang-abc" id="a3">A store</Link></li>
<li><Link href="/a/invite/TOKEN-xyz-1" id="a4">A invite</Link></li>
<li><Link href="/b/contacts/view?id=123" id="b1">B contact 123</Link></li>
<li><Link href="/b/x/view?objectKey=khach&viewKey=kanban1" id="b2">B view</Link></li>
<li><Link href="/b/s/view?slug=cua-hang-abc" id="b3">B store</Link></li>
<li><Link href="/b/invite/accept#TOKEN-xyz-1" id="b4">B invite</Link></li>
</ul></main>}
