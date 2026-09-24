/*
 * Worker di Cloudflare per «I miei impegni 2026/27»
 *
 * GET  /c/<codice>.ics   calendario in abbonamento di un collega (indirizzo fisso)
 * PUT  /stato/<codice>   l'app salva le scelte del collega (classi, appuntamenti tolti, promemoria)
 * GET  /cal.ics?s=...    vecchio formato, senza salvataggio
 *
 * Le date NON stanno qui: vengono lette dall'app pubblicata su GitHub
 * (blocco <script id="dati"> di index.html). Per cambiare una data basta
 * aggiornare index.html su GitHub: questo file non va più toccato.
 *
 * Richiede un archivio KV collegato con il nome STATI
 * (Impostazioni del Worker > Associazioni > Spazio dei nomi KV).
 */
const APP = "https://losynet.github.io/piano-annuale-attivita/";
const ORIGINE = "https://losynet.github.io";
const CODICE = /^[A-Za-z0-9_-]{16,64}$/;

function makeCore(D){

const {IST,ORD,IND,K,MP,BLOCKS,GEN,IIS,GLOC}=D;const ALL=ORD;
/* ---------- helpers ---------- */
const pad=n=>String(n).padStart(2,"0");
const hm=s=>{const [h,m]=s.split(/[.:]/).map(Number);return h*60+m;};
const fromMin=n=>pad(Math.floor(n/60))+":"+pad(n%60);
const parseD=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);};
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const addDays=(s,n)=>{const d=parseD(s);d.setDate(d.getDate()+n);return ymd(d);};
const annoOf=c=>({I:1,II:2,III:3,IV:4,V:5})[c.split(" ")[0]]||0;
const GG=["dom","lun","mar","mer","gio","ven","sab"];
const MESI=["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];

function expandClasses(){
  const out=[];
  for(const [ist,kind,dates,str] of BLOCKS){
    const slot=kind==="d15"?60:45;
    const items=str.split("|").map(x=>{let [c,t]=x.split("@");let i=ist;
      if(c.includes(":")){[i,c]=c.split(":");}return {ist:i,cls:c.trim(),m:hm(t)};});
    const times=[...new Set(items.map(x=>x.m))].sort((a,b)=>a-b);
    for(const d of dates) for(const it of items){
      const nx=times.find(t=>t>it.m);const dur=nx?Math.min(slot,nx-it.m):slot;
      out.push({d,s:fromMin(it.m),e:fromMin(it.m+dur),cat:"classe",ist:[it.ist],cls:it.cls,
        t:K[kind]+" "+it.cls,place:IST[it.ist].nome,loc:IST[it.ist].loc});
    }
  }
  return out;
}
const CLASS_EV=expandClasses();

function compute(st,today){
  const sel=st.sel, o=st.opts, has=i=>Object.prototype.hasOwnProperty.call(sel,i);
  const tri=Object.keys(sel).some(i=>sel[i].some(c=>annoOf(c)>=3));
  const res=[];
  for(const ev of CLASS_EV) if(has(ev.ist[0])&&sel[ev.ist[0]].includes(ev.cls)) res.push({...ev});
  for(const g of GEN){
    if(!g.ist.some(has)) continue;
    if((g.cat==="coll"&&!o.coll)||(g.cat==="fam"&&!o.fam)||(g.cat==="glo"&&!o.glo)||(g.cat==="cal"&&!o.cal)) continue;
    if(g.tri&&!tri) continue;
    const ev={...g};ev.fin=!!g.e;
    // fine solo interna, per il controllo delle sovrapposizioni
    if(!ev.all&&!ev.e) ev.e=fromMin(hm(ev.s)+ev.dur);
    if(!ev.loc) ev.loc=g.ist.length===1?IST[g.ist[0]].loc:IIS;
    ev.place=g.ist.length===ALL.length?"Tutto l'istituto":g.ist.filter(has).map(i=>IST[i].nome).join(", ");
    res.push(ev);
  }
  const vis=res.filter(e=>o.past||(e.to||e.d)>=today);
  vis.sort((a,b)=>(a.d+(a.all?"00:00":a.s)).localeCompare(b.d+(b.all?"00:00":b.s)));
  const hid=new Set(st.hidden||[]),hidden=[];
  for(const e of vis)e.id=hash(e.d+"|"+(e.s||"")+"|"+e.t+"|"+(e.cls||"")+"|"+e.ist.join(","));
  const shown=vis.filter(e=>{if(hid.has(e.id)){hidden.push(e);return false;}return true;});
  let clashes=0;
  const timed=shown.filter(e=>!e.all);
  for(let i=0;i<timed.length;i++)for(let j=i+1;j<timed.length;j++){
    const a=timed[i],b=timed[j]; if(a.d!==b.d) continue;
    if(hm(a.s)<hm(b.e)&&hm(b.s)<hm(a.e)){
      (a.clash=a.clash||[]).push(b.t+" ("+b.place+")");
      (b.clash=b.clash||[]).push(a.t+" ("+a.place+")"); clashes++;
    }
  }
  return {list:shown,clashes,hidden};
}

/* ---------- ICS ---------- */
function esc(s){return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n");}
function fold(line){
  const enc=new TextEncoder(); if(enc.encode(line).length<=75) return line;
  const out=[];let cur="",len=0;
  for(const ch of line){const b=enc.encode(ch).length;const max=out.length?74:75;
    if(len+b>max){out.push(cur);cur="";len=0;} cur+=ch;len+=b;}
  out.push(cur);return out.join("\r\n ");
}
function hash(s){let x=5381;for(const c of s)x=((x<<5)+x+c.codePointAt(0))>>>0;return x.toString(36);}
function buildICS(list,alarm){
  const now=new Date(),st=now.getUTCFullYear()+pad(now.getUTCMonth()+1)+pad(now.getUTCDate())+"T"+pad(now.getUTCHours())+pad(now.getUTCMinutes())+pad(now.getUTCSeconds())+"Z";
  const L=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Gianni Losenno per la scuola//Impegni 2026-27//IT","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "X-WR-CALNAME:Impegni scuola 2026/27","REFRESH-INTERVAL;VALUE=DURATION:PT6H","X-PUBLISHED-TTL:PT6H","X-WR-TIMEZONE:Europe/Rome",
    "BEGIN:VTIMEZONE","TZID:Europe/Rome",
    "BEGIN:DAYLIGHT","TZOFFSETFROM:+0100","TZOFFSETTO:+0200","TZNAME:CEST","DTSTART:19700329T020000","RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU","END:DAYLIGHT",
    "BEGIN:STANDARD","TZOFFSETFROM:+0200","TZOFFSETTO:+0100","TZNAME:CET","DTSTART:19701025T030000","RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU","END:STANDARD",
    "END:VTIMEZONE"];
  const alarmBlock=trig=>["BEGIN:VALARM","ACTION:DISPLAY","DESCRIPTION:Promemoria","TRIGGER:"+trig,"END:VALARM"];
  for(const e of list){
    const summary=e.cat==="classe"?e.t+", "+e.place:e.t;
    const desc=[e.note,e.clash?"Attenzione: si sovrappone a "+e.clash.join("; "):"","Fonte: Piano annuale delle attività 2026/27, I.I.S. Pisticci-Montalbano"].filter(Boolean).join("\n");
    L.push("BEGIN:VEVENT","UID:"+hash(e.d+(e.s||"")+summary)+"-"+e.d.replace(/-/g,"")+"@impegni-2026-27","DTSTAMP:"+st,
      "SUMMARY:"+esc(summary),"DESCRIPTION:"+esc(desc));
    if(e.loc) L.push("LOCATION:"+esc(e.loc));
    if(e.all){
      L.push("DTSTART;VALUE=DATE:"+e.d.replace(/-/g,""),"DTEND;VALUE=DATE:"+addDays(e.to||e.d,1).replace(/-/g,""),"TRANSP:TRANSPARENT");
      if(alarm!=="0"&&e.cat!=="cal") L.push(...alarmBlock("-PT15H"));
    }else{
      const d=e.d.replace(/-/g,"");
      L.push("DTSTART;TZID=Europe/Rome:"+d+"T"+e.s.replace(":","")+"00","DTEND;TZID=Europe/Rome:"+d+"T"+(e.fin?e.e:e.s).replace(":","")+"00");
      if(alarm==="60"||alarm==="both") L.push(...alarmBlock("-PT1H"));
      if(alarm==="1440"||alarm==="both") L.push(...alarmBlock("-P1D"));
    }
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n")+"\r\n";
}
function gcal(e){
  const p=new URLSearchParams({action:"TEMPLATE",text:e.cat==="classe"?e.t+", "+e.place:e.t,
    details:(e.note?e.note+"\n":"")+"Piano annuale delle attività 2026/27",location:e.loc||"",ctz:"Europe/Rome"});
  const d0=e.d.replace(/-/g,"");
  p.set("dates",e.all?d0+"/"+addDays(e.to||e.d,1).replace(/-/g,""):d0+"T"+e.s.replace(":","")+"00/"+d0+"T"+(e.fin?e.e:e.s).replace(":","")+"00");
  return "https://calendar.google.com/calendar/render?"+p.toString();
}

/* Classi scelte per sede, a partire dallo stato salvato */
function selOf(ind,cls){
  const sel={};
  for(const I of IND.filter(I=>ind.includes(I.id))){if(!sel[I.sede])sel[I.sede]=[];
    for(const c of I.classi)if(cls.includes(I.sede+"|"+c)&&!sel[I.sede].includes(c))sel[I.sede].push(c);}
  return sel;
}

  return {compute, buildICS, selOf};
}

let cache = {at: 0, core: null};
async function getCore(){
  if (cache.core && Date.now() - cache.at < 5 * 60 * 1000) return cache.core;
  const r = await fetch(APP, {cf: {cacheTtl: 300}});
  if (!r.ok) throw new Error("App non raggiungibile (" + r.status + ")");
  const html = await r.text();
  const m = html.match(/<script type="application\/json" id="dati">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Dati non trovati nell'app");
  cache = {at: Date.now(), core: makeCore(JSON.parse(m[1]))};
  return cache.core;
}

function decodeState(s){
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function valid(st){
  return st && Array.isArray(st.ind) && Array.isArray(st.cls) && st.ind.length <= 20 && st.cls.length <= 200 &&
    (!st.hidden || (Array.isArray(st.hidden) && st.hidden.length <= 500)) &&
    [...st.ind, ...st.cls, ...(st.hidden || [])].every(x => typeof x === "string" && x.length <= 40);
}
const cors = {"Access-Control-Allow-Origin": ORIGINE, "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400"};
const text = (t, status) => new Response(t, {status, headers: {"Content-Type": "text/plain; charset=utf-8", ...cors}});

async function calendario(st){
  const C = await getCore();
  const opts = {...(st.opts || {}), past: true}; // in abbonamento restano anche gli impegni passati
  const {list} = C.compute({sel: C.selOf(st.ind, st.cls), opts, hidden: st.hidden || []}, "0000-00-00");
  return new Response(C.buildICS(list, opts.alarm || "60"), {headers: {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="impegni-scuola-2026-27.ics"',
    "Cache-Control": "no-cache"}});
}

export default {
  async fetch(request, env){
    const url = new URL(request.url), p = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, {status: 204, headers: cors});
    try {
      // Salvataggio delle scelte
      let m = p.match(/^\/stato\/([^/]+)$/);
      if (m) {
        if (request.method !== "PUT") return text("Metodo non ammesso", 405);
        if (!env.STATI) return text("Archivio KV non collegato", 501);
        if (!CODICE.test(m[1])) return text("Codice non valido", 400);
        const body = await request.text();
        if (body.length > 20000) return text("Troppi dati", 413);
        const st = JSON.parse(body);
        if (!valid(st)) return text("Scelte non valide", 400);
        const nuovo = JSON.stringify({ind: st.ind, cls: st.cls, hidden: st.hidden || [], opts: st.opts || {}});
        if (await env.STATI.get(m[1]) !== nuovo) await env.STATI.put(m[1], nuovo);
        return text("OK", 200);
      }
      // Calendario in abbonamento
      m = p.match(/^\/c\/([^/]+)\.ics$/);
      if (m) {
        if (!CODICE.test(m[1])) return text("Codice non valido", 400);
        let st = env.STATI ? await env.STATI.get(m[1], "json") : null;
        if (!st && url.searchParams.get("s")) {
          st = decodeState(url.searchParams.get("s"));   // prima volta: scelte contenute nell'indirizzo
          if (!valid(st)) return text("Scelte non valide", 400);
          if (env.STATI) await env.STATI.put(m[1], JSON.stringify({ind: st.ind, cls: st.cls, hidden: st.hidden || [], opts: st.opts || {}}));
        }
        if (!st) return text("Calendario non trovato", 404);
        return await calendario(st);
      }
      // Vecchio formato
      if (p.endsWith(".ics") && url.searchParams.get("s")) {
        const st = decodeState(url.searchParams.get("s"));
        if (!valid(st)) return text("Scelte non valide", 400);
        return await calendario(st);
      }
      return Response.redirect(APP, 302);
    } catch (e) {
      return text("Errore: " + e.message, 400);
    }
  }
};
