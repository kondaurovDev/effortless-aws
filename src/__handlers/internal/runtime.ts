import { Layer, ManagedRuntime } from "effect";

export const createRuntime = <R, E>(
  layer?: Layer.Layer<R, E, never>
) =>
  layer ?
    ManagedRuntime.make(layer) :
    ManagedRuntime.make(Layer.empty) as ManagedRuntime.ManagedRuntime<R, never>
