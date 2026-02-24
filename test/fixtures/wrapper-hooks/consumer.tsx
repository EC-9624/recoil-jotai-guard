import {useSetFoo} from './wrapper-arrow';
import {useFoo} from './wrapper-tuple';

export function DirectConsumer() {
  const setFoo = useSetFoo();
  setFoo('hello');
  return <div />;
}

export function TupleConsumer() {
  const [foo, setFoo] = useFoo();
  setFoo('world');
  return <div>{foo}</div>;
}
