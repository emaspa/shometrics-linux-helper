import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { join } from "node:path";

const def = protoLoader.loadSync("shometrics/v1/helper_grpc_service.proto",
    { includeDirs: [join(import.meta.dirname, "proto")], keepCase: true, defaults: true });
const proto = grpc.loadPackageDefinition(def);
const client = new proto.shometrics.v1.MetricSourceService(
    "unix:///tmp/shometrics-helper/ShoMetrics.Source.Windows.Grpc.v1",
    grpc.credentials.createInsecure());

const call = (method, req) => new Promise((res, rej) =>
    client[method](req, (e, r) => e ? rej(e) : res(r)));

const health = await call("GetSourceHealth", {});
console.log("health:", JSON.stringify(health));
const list = await call("ListMetricDescriptors", { metric_ids: [] });
console.log("descriptors:", list.descriptor_snapshot.descriptors.length);
for (const d of list.descriptor_snapshot.descriptors.slice(0, 8))
    console.log(" ", d.descriptor.metric_id, "|", d.raw_sensor_identity.hardware_name, "/", d.raw_sensor_identity.sensor_name);
const ids = list.descriptor_snapshot.descriptors.slice(0, 6).map(d => d.descriptor.metric_id);
const snap = await call("ReadMetricSnapshot", { metric_ids: ids, include_descriptors: false });
for (const [id, v] of Object.entries(snap.snapshot.metrics))
    console.log("value:", id, "=", v.scalar, "unit", v.unit);
process.exit(0);
