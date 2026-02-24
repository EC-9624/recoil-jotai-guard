import {useRecoilCallback} from 'recoil';
import {myAtom, otherAtom} from './recoil-basic';

function Component() {
  // Style A: inline nested destructuring
  const cb = useRecoilCallback(
    ({set, snapshot: {getPromise}}) =>
      async () => {
        const val = await getPromise(myAtom);
        set(myAtom, 'new');
      },
  );

  // Style B: snapshot as variable
  const cb2 = useRecoilCallback(({set, snapshot}) => async () => {
    const val = await snapshot.getPromise(otherAtom);
    set(otherAtom, val);
  });

  // Reset inside callback
  const cb3 = useRecoilCallback(({reset}) => () => {
    reset(myAtom);
  });
}
