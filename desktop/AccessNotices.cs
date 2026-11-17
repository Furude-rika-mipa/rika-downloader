using System;
using System.Collections.Generic;

namespace VideoDownloaderApp
{
    internal sealed class AccessNotice
    {
        internal string Kind;
        internal string Detail;
    }

    internal sealed class AccessNotices
    {
        private readonly HashSet<string> seen = new HashSet<string>();
        private readonly Queue<AccessNotice> pending = new Queue<AccessNotice>();
        private bool initialized;

        internal void Observe(string id, string status, string kind, string detail)
        {
            if (status != "error" || (kind != "login" && kind != "verification") || String.IsNullOrEmpty(id) || !seen.Add(id)) return;
            if (initialized) pending.Enqueue(new AccessNotice { Kind = kind, Detail = detail });
        }

        internal void FinishRefresh(HashSet<string> present)
        {
            seen.IntersectWith(present);
            initialized = true;
        }

        internal AccessNotice Dequeue()
        {
            return pending.Count == 0 ? null : pending.Dequeue();
        }
    }
}
