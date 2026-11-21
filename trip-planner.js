/* Turmapper for familiens feriekart.
   Lokale mapper og innloggede skymapper holdes adskilt. */
(() => {
  "use strict";
  const STORAGE_KEY = "familien-feriedrommer-turplaner-v1";
  const STARTER = [
    {id:"ny-tur",name:"Min første tur",lat:47.0,lng:8.0,radiusKm:100,placeIds:[]}
  ];
  const copy = value => JSON.parse(JSON.stringify(value));
  const validCoordinate = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat)<=90 && Math.abs(lng)<=180;
  function sanitizeTrip(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id=String(raw.id||"").slice(0,90), name=String(raw.name||"").trim().slice(0,90);
    const lat=Number(raw.lat),lng=Number(raw.lng),radiusKm=Number(raw.radiusKm);
    if (!id || !name || !validCoordinate(lat,lng)) return null;
    return {id,name,lat,lng,radiusKm:Number.isFinite(radiusKm)?Math.min(500,Math.max(10,radiusKm)):100,
      placeIds:[...new Set(Array.isArray(raw.placeIds)?raw.placeIds.filter(x=>typeof x==="string"&&x.length<130):[])].slice(0,500)};
  }
  let storageAvailable=true, saved=null;
  try {
    saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
  } catch(e) { storageAvailable=false; }
  let trips=Array.isArray(saved?.trips) ? saved.trips.map(sanitizeTrip).filter(Boolean).slice(0,40) : copy(STARTER);
  if (!trips.length) trips=copy(STARTER);
  // Newly introduced default folders remain available to users of older builds.
  for(const starter of STARTER) {
    if (!trips.some(t=>t.id===starter.id)) {
      // Do not re-create folders that the user explicitly deleted.
      if (!Array.isArray(saved?.trips)) trips.push(copy(starter));
    }
  }
  let selectedId=typeof saved?.selectedId==="string"&&trips.some(t=>t.id===saved.selectedId)?saved.selectedId:trips[0].id;
  let mode="all",places=[],byId=new Map();
  let map=null,baseLayer=null,controls={};
  const EMPTY={id:"",name:"Ingen tur valgt",lat:47,lng:8,radiusKm:100,placeIds:[]};
  const current=()=>trips.find(t=>t.id===selectedId)||trips[0]||EMPTY;
  let localState=null;
  const cloud=()=>window.ferieCloud;
  const cloudActive=()=>!!localState;
  const canMutate=()=>!cloudActive()||cloud()?.writable();
  const canEdit=()=>!!current().id&&canMutate();
  const canDelete=()=>canEdit()&&(!cloudActive()||cloud()?.canDelete(current().id));
  function refreshControls(){
    if(!controls.root)return;
    for(const id of ["trip-rename","trip-set-center","trip-center"]){
      const el=controls.root.querySelector("#"+id);if(el)el.disabled=id==="trip-center"?!current().id:!canEdit();
    }
    controls.radius.disabled=!canEdit();
    controls.root.querySelector("#trip-new").disabled=!canMutate();
    controls.root.querySelector("#trip-delete").disabled=!canDelete()||(!cloudActive()&&trips.length<=1);
    controls.root.querySelector("#trip-import").disabled=!canMutate();
    controls.root.querySelector("#trip-export").disabled=!trips.length;
    controls.root.querySelectorAll(".trip-tiny-add,.trip-remove").forEach(el=>el.disabled=!canEdit());
    document.querySelectorAll("[data-trip-place-id]").forEach(el=>el.disabled=!canEdit());
    for(const [name,b] of Object.entries(controls.modes||{}))b.disabled=name!=="all"&&!current().id;
  }
  function replaceCloudTrips(next){
    trips=next.map(sanitizeTrip).filter(Boolean);
    if(!trips.some(t=>t.id===selectedId))selectedId=trips[0]?.id||"";
    if(!trips.length)mode="all";
    renderSelect();updateView(false);
  }
  function enterCloud(){
    if(!localState)localState={trips:copy(trips),selectedId,mode};
    replaceCloudTrips([]);
  }
  function leaveCloud(){
    if(!localState)return;
    trips=localState.trips;selectedId=localState.selectedId;mode=localState.mode;localState=null;
    renderSelect();updateView(false);
  }
  const numberFormat=new Intl.NumberFormat("nb-NO",{maximumFractionDigits:0});
  function km(a,b) {
    const deg=Math.PI/180, r1=a[0]*deg,r2=b[0]*deg;
    const dlat=(b[0]-a[0])*deg,dlng=(b[1]-a[1])*deg;
    const h=Math.sin(dlat/2)**2+Math.cos(r1)*Math.cos(r2)*Math.sin(dlng/2)**2;
    return 12742*Math.asin(Math.sqrt(Math.min(1,h)));
  }
  function save() {
    if(cloudActive()){cloud()?.save(copy(trips));return true;}
    return saveLocal();
  }
  function saveLocal() {
    if(cloudActive()||!storageAvailable) return false;
    try {localStorage.setItem(STORAGE_KEY,JSON.stringify({version:1,trips,selectedId}));return true;}
    catch(e){storageAvailable=false;renderStorageNote();return false;}
  }
  function updateView(fit=false) {
    window.ferieRerender?.(fit);
    refreshButtons();
    renderLists();
    renderHomeMarker();
  }
  function hasPlace(placeId){return current().placeIds.includes(String(placeId));}
  function togglePlace(placeId){
    const t=current(),id=String(placeId);
    if (!canEdit()||!byId.has(id)) return;
    if (t.placeIds.includes(id)) t.placeIds=t.placeIds.filter(x=>x!==id);
    else t.placeIds.push(id);
    save();
    updateView(false);
  }
  function refreshButtons(){
    document.querySelectorAll("[data-trip-place-id]").forEach(button=>{
      const selected=hasPlace(button.dataset.tripPlaceId);
      button.textContent=selected?"✓ I turen – fjern":"+ Legg til i tur";
      button.classList.toggle("trip-added",selected);
      button.title=selected?"Fjern fra "+current().name+" (behold i feriedrømmene)":"Legg til i "+current().name;
      button.disabled=!canEdit();
      button.setAttribute("aria-pressed",String(selected));
    });
  }
  function createToggleButton(placeId) {
    const button=document.createElement("button");
    button.type="button";
    button.className="trip-add-button";
    button.dataset.tripPlaceId=String(placeId);
    const selected=hasPlace(String(placeId));
    button.textContent=selected?"✓ I turen – fjern":"+ Legg til i tur";
    button.classList.toggle("trip-added",selected);
    button.disabled=!canEdit();
    button.setAttribute("aria-pressed",String(selected));
    button.title=selected?"Fjern fra "+current().name+" (behold i feriedrømmene)":"Legg til i "+current().name;
    button.addEventListener("click",event=>{event.stopPropagation();togglePlace(placeId);});
    return button;
  }
  function filterPlaces(list){
    if(mode==="selected") return list.filter(p=>hasPlace(p.id));
    if(mode==="near") {
      const t=current();
      return list.filter(p=>validCoordinate(+p.lat,+p.lng)&&km([t.lat,t.lng],[+p.lat,+p.lng])<=t.radiusKm)
        .sort((a,b)=> Number(hasPlace(b.id))-Number(hasPlace(a.id))||
             km([t.lat,t.lng],[a.lat,a.lng])-km([t.lat,t.lng],[b.lat,b.lng]));
    }
    return list;
  }
  function renderHomeMarker(){
    if(!map||!baseLayer) return;
    baseLayer.clearLayers();
    if(mode==="all"||!current().id)return;
    const t=current(),point=[t.lat,t.lng];
    L.circleMarker(point,{radius:8,color:"#174e68",weight:3,fillColor:"#42b7cf",fillOpacity:1})
      .addTo(baseLayer).bindPopup("Område for turen: "+t.name+" · "+t.radiusKm+" km søkeradius");
  }
  function zoomToTrip(){
    if(!map||!current().id) return;
    const t=current();
    map.setView([t.lat,t.lng],t.radiusKm<=70?10:t.radiusKm<=170?9:8);
    renderHomeMarker();
  }
  function showPlace(p){
    window.ferieShowPlace?.(p.id);
  }
  function element(tag,className,text){
    const el=document.createElement(tag);
    if(className)el.className=className;
    if(text!==undefined)el.textContent=text;
    return el;
  }
  function renderLists(){
    if(!controls.selected||!controls.nearby)return;
    const t=current();
    controls.selected.replaceChildren();
    if(!t.id){
      controls.count.textContent="Ingen turmapper i skyen";
      controls.selected.append(element("p","trip-empty","Opprett en ny tur eller velg «Kopier lokale turmapper» under Skysynkronisering."));
      controls.nearby.replaceChildren();controls.nearLabel.textContent="Nærliggende feriedrømmer";
      refreshControls();return;
    }
    const selected=t.placeIds.map(id=>byId.get(id)).filter(Boolean);
    controls.count.textContent=selected.length+" aktuelle reisemål";
    if(!selected.length) controls.selected.append(element("p","trip-empty","Ingen steder lagt til ennå. Velg fra forslagene under eller fra et kort i kartet."));
    for(const p of selected){
      const row=element("div","trip-entry"),name=element("span","trip-entry-name",p.name);
      const open=element("button","trip-tiny","Kart");
      open.type="button";open.addEventListener("click",()=>showPlace(p));
      const remove=element("button","trip-tiny trip-remove","Fjern");
      remove.type="button";remove.title="Fjern bare fra denne turen";
      remove.addEventListener("click",()=>togglePlace(p.id));
      row.append(name,open,remove);controls.selected.append(row);
    }
    controls.nearby.replaceChildren();
    const near=places.filter(p=>validCoordinate(+p.lat,+p.lng)&&!hasPlace(p.id)&&
      km([t.lat,t.lng],[+p.lat,+p.lng])<=t.radiusKm).sort((a,b)=>
      km([t.lat,t.lng],[a.lat,a.lng])-km([t.lat,t.lng],[b.lat,b.lng]));
    controls.nearLabel.textContent="Andre feriedrømmer innen "+t.radiusKm+" km i luftlinje ("+near.length+")";
    if(!near.length)controls.nearby.append(element("p","trip-empty","Ingen flere registrerte reisemål i denne radiusen. Prøv å øke søkeavstanden."));
    for(const p of near.slice(0,15)){
      const d=numberFormat.format(km([t.lat,t.lng],[p.lat,p.lng]));
      const row=element("div","trip-entry");
      const name=element("span","trip-entry-name",p.name+" · "+d+" km");
      const focus=element("button","trip-tiny","Kart");focus.type="button";focus.addEventListener("click",()=>showPlace(p));
      const add=element("button","trip-tiny trip-tiny-add","+ Legg til");
      add.type="button";add.addEventListener("click",()=>togglePlace(p.id));
      row.append(name,focus,add);controls.nearby.append(row);
    }
    if(near.length>15)controls.nearby.append(element("p","trip-empty","Viser de 15 nærmeste. Bruk «Vis i nærheten» for hele området."));
    refreshControls();
  }
  function renderStorageNote(){
    if(!controls.storage)return;
    if(cloudActive()){controls.storage.textContent="Innloggede turmapper lagres i Supabase. De lokale originalene beholdes separat. Eksporter ved behov.";return;}
    controls.storage.textContent=storageAvailable?
      "Lagres i denne nettleseren. Bruk «Eksporter» for sikkerhetskopi eller overføring til en annen enhet.":
      "Nettleseren tillater ikke lagring. Endringer vil forsvinne når siden lukkes – eksporter en sikkerhetskopi.";
  }
  function renderSelect(){
    if(!controls.select)return;
    controls.select.replaceChildren();
    for(const t of trips){const opt=new Option(t.name,t.id);controls.select.append(opt);}
    controls.select.value=selectedId;
    controls.select.disabled=!trips.length;
    controls.radius.value=String(current().radiusKm);
    renderMode();
    renderLists();
    renderStorageNote();
    renderHomeMarker();
  }
  function renderMode(){
    for(const [name,b] of Object.entries(controls.modes||{})){
      b.classList.toggle("active",mode===name);
      b.setAttribute("aria-pressed",String(mode===name));
    }
  }
  function setMode(next){
    if(!["all","near","selected"].includes(next)||next!=="all"&&!current().id)return;
    mode=next;
    renderMode();
    updateView(false);
    if(next==="near")zoomToTrip();
    if(next==="selected"){
      const pts=current().placeIds.map(id=>byId.get(id)).filter(p=>p&&validCoordinate(+p.lat,+p.lng)).map(p=>[+p.lat,+p.lng]);
      if(pts.length>=2)map.fitBounds(pts,{padding:[45,45],maxZoom:12});
      else if(pts.length===1)map.setView(pts[0],12);
      else zoomToTrip();
    }
  }
  function exportPlans(){
    const payload={format:"familiens-feriedrommer-turer",version:1,exportedAt:new Date().toISOString(),trips};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json;charset=utf-8"});
    const href=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=href;a.download="familiekart-turplaner.json";
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(href),6000);
  }
  async function importPlans(file){
    if(!file || file.size>1_000_000){alert("Velg en JSON-fil med turplaner (maks 1 MB).");return;}
    try{
      const loaded=JSON.parse(await file.text());
      if(loaded.format!=="familiens-feriedrommer-turer" || !Array.isArray(loaded.trips))throw new Error("Ukjent sikkerhetskopi");
      const cleaned=loaded.trips.map(sanitizeTrip).filter(Boolean).slice(0,40);
      if(!cleaned.length)throw new Error("Ingen gyldige turmapper");
      if(!canMutate())throw new Error("Vent til skysynkroniseringen er ferdig.");
      if(cloudActive()){
        if(!confirm("Importere "+cleaned.length+" turmapper som nye, private kopier i skyen? Ingen eksisterende skymapper erstattes."))return;
        const copies=cleaned.map(t=>({...t,id:crypto.randomUUID()}));
        trips=[...trips,...copies];selectedId=copies[0].id;mode="all";
      }else{
        if(!confirm("Erstatte de nåværende lokale turmappene med "+cleaned.length+" fra sikkerhetskopien?"))return;
        trips=cleaned;selectedId=trips[0].id;mode="all";
      }
      save();renderSelect();updateView(false);
    }catch(err){alert("Kunne ikke lese turplanene: "+err.message);}
  }
  function createFolder(){
    if(!canMutate())return;
    if(trips.length>=40){alert("Maksimalt 40 turmapper ved manuell opprettelse.");return;}
    const name=prompt("Navn på turen (kartets nåværende sentrum brukes som geografisk utgangspunkt):","Ny tur");
    if(!name?.trim())return;
    const mid=map.getCenter(),id=crypto.randomUUID();
    const t={id,name:name.trim().slice(0,90),lat:mid.lat,lng:mid.lng,radiusKm:100,placeIds:[]};
    trips.push(t);selectedId=id;mode="near";save();renderSelect();updateView(false);
  }
  function init(){
    map=window.ferieMap;
    if(!map || !window.L)return;
    places=Array.isArray(window.ferieData)?window.ferieData:[];
    byId=new Map(places.map(p=>[String(p.id),p]));
    baseLayer=L.layerGroup().addTo(map);
    const root=document.getElementById("trip-planner");
    if(!root)return;
    const select=root.querySelector("#trip-select"),
      radius=root.querySelector("#trip-radius"),
      selected=root.querySelector("#trip-selected"),
      nearby=root.querySelector("#trip-nearby"),
      count=root.querySelector("#trip-count"),
      nearLabel=root.querySelector("#trip-near-label"),
      storage=root.querySelector("#trip-storage");
    controls={root,select,radius,selected,nearby,count,nearLabel,storage,modes:{}};
    for(const button of root.querySelectorAll("[data-trip-mode]")){
      controls.modes[button.dataset.tripMode]=button;
      button.addEventListener("click",()=>setMode(button.dataset.tripMode));
    }
    select.addEventListener("change",()=>{selectedId=select.value;if(!cloudActive())saveLocal();renderSelect();updateView(false);cloud()?.updateUI();zoomToTrip();});
    radius.addEventListener("change",()=>{
      if(!canEdit()){radius.value=String(current().radiusKm);return;}
      const n=Number(radius.value);
      if(!Number.isFinite(n)){radius.value=String(current().radiusKm);return;}
      current().radiusKm=Math.round(Math.min(500,Math.max(10,n)));
      save();renderSelect();updateView(false);
    });
    root.querySelector("#trip-new").addEventListener("click",createFolder);
    root.querySelector("#trip-rename").addEventListener("click",()=>{
      if(!canEdit())return;
      const next=prompt("Gi turmappen nytt navn:",current().name);
      if(!next?.trim())return;current().name=next.trim().slice(0,90);
      save();renderSelect();refreshButtons();
    });
    root.querySelector("#trip-delete").addEventListener("click",()=>{
      const t=current();
      if(!canDelete())return;
      if(!cloudActive()&&trips.length<=1){alert("Du må beholde minst én lokal turmappe.");return;}
      if(!confirm('Slette turmappen «'+t.name+'»? Stedene beholdes i hovedlisten.'))return;
      trips=trips.filter(x=>x.id!==t.id);selectedId=trips[0]?.id||"";
      mode="all";save();renderSelect();updateView(false);
    });
    root.querySelector("#trip-center").addEventListener("click",zoomToTrip);
    root.querySelector("#trip-set-center").addEventListener("click",()=>{
      if(!canEdit())return;
      const c=map.getCenter();
      if(!confirm("Bruke kartets nåværende midtpunkt som området for «"+current().name+"»?"))return;
      current().lat=c.lat;current().lng=c.lng;save();renderSelect();updateView(false);
    });
    root.querySelector("#trip-export").addEventListener("click",exportPlans);
    root.querySelector("#trip-import").addEventListener("change",async event=>{
      await importPlans(event.target.files[0]);event.target.value="";
    });
    renderSelect();
    refreshButtons();
    window.ferieRerender?.(false);
    cloud()?.init({
      sanitize:sanitizeTrip, getTrips:()=>copy(trips), localTrips:()=>copy(localState?.trips||trips),
      selectedId:()=>current().id, replace:replaceCloudTrips,enterCloud,leaveCloud,refreshControls
    });
  }
  window.feriePlanner={createToggleButton,filterPlaces,isSelected:hasPlace,setMode};
  function onReady(){
    if(!window.ferieMap||!Array.isArray(window.ferieData))return;
    if(map){places=window.ferieData;byId=new Map(places.map(p=>[String(p.id),p]));renderLists();return;}
    init();
  }
  window.addEventListener("ferie:places-ready",onReady);
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",onReady,{once:true});
  else onReady();
})();